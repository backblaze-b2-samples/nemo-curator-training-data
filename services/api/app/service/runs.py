"""Curation-run orchestration (public service facade).

Coordinates the run lifecycle — create / read / edit / delete / execute — plus
the corpus-explorer reads and dashboard aggregation, over the B2 manifest store
(`repo.runs_store`). Heavy execution internals and shared primitives live in
`service/run_engine.py`; this module re-exposes the exceptions the routes catch.
"""

import json
import logging
import threading
import uuid

from app.repo import runs_store
from app.service.run_engine import (
    STAGE_ORDER,
    RunBusyError,
    RunNotFoundError,
    RunValidationError,
    _running,
    _running_lock,
    load,
    now,
    run_pipeline,
    save,
)
from app.types.formatting import humanize_bytes
from app.types.runs import (
    CreateRunRequest,
    DocumentPreview,
    FunnelPoint,
    RunManifest,
    RunStats,
    RunSummary,
    ShardDownload,
    ShardInfo,
    ShardList,
    StageResult,
    UpdateRunRequest,
)

logger = logging.getLogger(__name__)

# Re-exported so `runtime.runs` and tests import them from one place.
__all__ = [
    "RunBusyError",
    "RunNotFoundError",
    "RunValidationError",
    "create_run",
    "delete_run",
    "execute_run",
    "get_run",
    "get_run_stats",
    "list_run_shards",
    "list_runs",
    "preview_document",
    "shard_download_url",
    "update_run",
]


# --- CRUD --------------------------------------------------------------------
def create_run(req: CreateRunRequest) -> RunManifest:
    run_id = uuid.uuid4().hex[:16]
    ts = now()
    manifest = RunManifest(
        run_id=run_id,
        name=req.name.strip(),
        config=req.config,
        status="pending",
        created_at=ts,
        updated_at=ts,
        stages=[StageResult(stage=s) for s in STAGE_ORDER],
    )
    save(manifest)
    logger.info("Curation run created: run_id=%s name=%s", run_id, manifest.name)
    return manifest


def _summary(m: RunManifest) -> RunSummary:
    final_docs = m.source_docs
    for stage in STAGE_ORDER:
        sr = next((s for s in m.stages if s.stage == stage), None)
        if sr and sr.status == "completed":
            final_docs = sr.docs_out
    return RunSummary(
        run_id=m.run_id,
        name=m.name,
        status=m.status,
        source=m.config.source,
        created_at=m.created_at,
        updated_at=m.updated_at,
        source_docs=m.source_docs,
        final_docs=final_docs,
        total_bytes_written=m.total_bytes_written,
        total_bytes_human=humanize_bytes(m.total_bytes_written),
        error=m.error,
    )


def _all_manifests() -> list[RunManifest]:
    manifests: list[RunManifest] = []
    for run_id in runs_store.list_run_ids():
        data = runs_store.get_manifest(run_id)
        if data is not None:
            manifests.append(RunManifest.model_validate(data))
    return manifests


def list_runs() -> list[RunSummary]:
    summaries = [_summary(m) for m in _all_manifests()]
    summaries.sort(key=lambda s: s.created_at, reverse=True)
    return summaries


def get_run(run_id: str) -> RunManifest:
    return load(run_id)


def update_run(run_id: str, req: UpdateRunRequest) -> RunManifest:
    with _running_lock:
        if run_id in _running:
            raise RunBusyError("Cannot edit a run while it is executing")
    manifest = load(run_id)
    if manifest.status == "running":
        raise RunBusyError("Cannot edit a run while it is executing")
    if req.name is not None:
        manifest.name = req.name.strip()
    if req.config is not None:
        manifest.config = req.config
    manifest.updated_at = now()
    save(manifest)
    return manifest


def delete_run(run_id: str) -> int:
    with _running_lock:
        if run_id in _running:
            raise RunBusyError("Cannot delete a run while it is executing")
    load(run_id)  # 404 rather than silent no-op
    return runs_store.delete_run(run_id)


def execute_run(run_id: str) -> RunManifest:
    manifest = load(run_id)
    with _running_lock:
        if run_id in _running or manifest.status == "running":
            raise RunBusyError("Run is already executing")
        _running.add(run_id)
    manifest.status = "running"
    manifest.error = None
    manifest.updated_at = now()
    for sr in manifest.stages:
        sr.status = "pending"
    save(manifest)
    threading.Thread(target=run_pipeline, args=(run_id,), daemon=True).start()
    return manifest


# --- corpus explorer reads ---------------------------------------------------
def list_run_shards(run_id: str, stage: str) -> ShardList:
    load(run_id)  # 404 if the run is gone
    shards = [
        ShardInfo(
            key=s["key"],
            filename=s["filename"],
            size_bytes=s["size"],
            size_human=s["size_human"],
        )
        for s in runs_store.list_shards(run_id, stage)
    ]
    return ShardList(run_id=run_id, stage=stage, shards=shards)


def preview_document(run_id: str, stage: str, shard: str, limit: int) -> DocumentPreview:
    load(run_id)
    prefix = runs_store.stage_prefix(run_id, stage)
    if not shard.startswith(prefix):  # keep reads scoped to this run/stage
        raise RunValidationError("Shard does not belong to this run and stage")
    text = runs_store.get_object_text(shard)
    documents: list[dict] = []
    lines = [ln for ln in text.splitlines() if ln.strip()]
    for ln in lines[:limit]:
        try:
            documents.append(json.loads(ln))
        except json.JSONDecodeError:
            documents.append({"text": ln})
    return DocumentPreview(
        run_id=run_id,
        stage=stage,
        shard=shard,
        documents=documents,
        returned=len(documents),
        truncated=len(lines) > limit,
    )


def shard_download_url(run_id: str, stage: str, shard: str) -> ShardDownload:
    load(run_id)
    prefix = runs_store.stage_prefix(run_id, stage)
    if not shard.startswith(prefix):
        raise RunValidationError("Shard does not belong to this run and stage")
    filename = shard.rsplit("/", 1)[-1]
    return ShardDownload(url=runs_store.presign_shard(shard, filename=filename))


# --- dashboard aggregation ---------------------------------------------------
_FUNNEL_LABELS = {
    "raw": "Raw",
    "deduped": "Deduplicated",
    "filtered": "Quality-filtered",
    "redacted": "PII-redacted",
}


def get_run_stats() -> RunStats:
    manifests = _all_manifests()
    documents_processed = 0
    documents_removed = 0
    pii_spans = 0
    total_bytes = 0
    funnel_totals = dict.fromkeys(STAGE_ORDER, 0)
    for m in manifests:
        documents_processed += m.source_docs
        total_bytes += m.total_bytes_written
        for sr in m.stages:
            documents_removed += sr.docs_removed
            pii_spans += sr.pii_spans_redacted
            if sr.status == "completed":
                funnel_totals[sr.stage] += sr.docs_out
    funnel = [
        FunnelPoint(stage=s, label=_FUNNEL_LABELS[s], documents=funnel_totals[s])
        for s in STAGE_ORDER
    ]
    recent = sorted(
        (_summary(m) for m in manifests), key=lambda s: s.created_at, reverse=True
    )[:10]
    return RunStats(
        total_runs=len(manifests),
        documents_processed=documents_processed,
        documents_removed=documents_removed,
        pii_spans_redacted=pii_spans,
        total_bytes_written=total_bytes,
        total_bytes_human=humanize_bytes(total_bytes),
        funnel=funnel,
        recent=recent,
    )
