"""Curation-run engine internals + shared primitives.

Split out of `service/runs.py` to keep each file under the 300-line ceiling.
Holds the run exceptions, manifest load/save helpers, source loading, and the
background pipeline execution that streams each NeMo Curator stage's output to
B2. `service/runs.py` is the public facade that imports from here.
"""

import json
import logging
import threading
from datetime import UTC, datetime
from pathlib import Path

from app.repo import curator, runs_store
from app.types.runs import RunConfig, RunManifest, StageResult

logger = logging.getLogger(__name__)

DEMO_CORPUS_PATH = Path(__file__).resolve().parent.parent / "data" / "demo-corpus.jsonl"
SHARD_SIZE = 25  # documents per JSONL shard — small so the demo produces >1 shard
STAGE_ORDER = ["raw", "deduped", "filtered", "redacted"]

# In-process guard: which run_ids are currently executing. Prevents a second
# execute and blocks edits/deletes mid-run. (The persisted manifest status is
# the durable source of truth across restarts.)
_running: set[str] = set()
_running_lock = threading.Lock()


class RunNotFoundError(Exception):
    def __init__(self, run_id: str):
        self.detail = f"Run '{run_id}' not found"
        super().__init__(self.detail)


class RunBusyError(Exception):
    def __init__(self, detail: str = "Run is currently executing"):
        self.detail = detail
        super().__init__(detail)


class RunValidationError(Exception):
    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


def now() -> datetime:
    return datetime.now(UTC)


def save(manifest: RunManifest) -> None:
    runs_store.put_manifest(manifest.run_id, manifest.model_dump(mode="json"))


def load(run_id: str) -> RunManifest:
    data = runs_store.get_manifest(run_id)
    if data is None:
        raise RunNotFoundError(run_id)
    return RunManifest.model_validate(data)


# --- source loading ----------------------------------------------------------
def _load_demo_corpus() -> list[dict]:
    docs: list[dict] = []
    with open(DEMO_CORPUS_PATH, encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            docs.append({"id": str(obj.get("id", f"demo-{i}")), "text": obj["text"]})
    return docs


def _load_b2_prefix(prefix: str) -> list[dict]:
    docs: list[dict] = []
    for n, obj in enumerate(runs_store.list_prefix_objects(prefix)):
        key = obj["key"]
        text = runs_store.get_object_text(key)
        if key.endswith(".jsonl"):
            for j, line in enumerate(text.splitlines()):
                line = line.strip()
                if not line:
                    continue
                parsed = json.loads(line)
                docs.append(
                    {"id": str(parsed.get("id", f"{key}#{j}")), "text": parsed["text"]}
                )
        else:
            docs.append({"id": f"{key}#{n}", "text": text})
    return docs


def load_source(config: RunConfig) -> list[dict]:
    if config.source == "demo":
        return _load_demo_corpus()
    if not config.source_prefix:
        raise RunValidationError("source_prefix is required when source is 'b2_prefix'")
    docs = _load_b2_prefix(config.source_prefix)
    if not docs:
        raise RunValidationError(
            f"No documents found under prefix '{config.source_prefix}'"
        )
    return docs


# --- execution ---------------------------------------------------------------
def _write_stage_shards(run_id: str, stage: str, docs: list[dict]) -> tuple[int, int]:
    shard_count = 0
    bytes_written = 0
    for i in range(0, max(len(docs), 1), SHARD_SIZE):
        chunk = docs[i : i + SHARD_SIZE]
        body = ("".join(json.dumps(d) + "\n" for d in chunk)).encode("utf-8")
        runs_store.put_shard(run_id, stage, shard_count, body)
        shard_count += 1
        bytes_written += len(body)
        if not docs:  # empty stage still writes one empty shard for lineage
            break
    return shard_count, bytes_written


def _fail(run_id: str, detail: str) -> None:
    try:
        manifest = load(run_id)
        manifest.status = "failed"
        manifest.error = detail
        for sr in manifest.stages:
            if sr.status in ("pending", "running"):
                sr.status = "failed"
        manifest.updated_at = now()
        save(manifest)
    except Exception as e:
        logger.error("Could not persist failure for run %s: %s", run_id, e)


def run_pipeline(run_id: str) -> None:
    """Thread target: run all configured stages, streaming each stage's shards
    and updated manifest to B2 so the polling UI shows live progress."""
    try:
        manifest = load(run_id)
        config = manifest.config
        raw_docs = load_source(config)

        stage_map = {s: StageResult(stage=s) for s in STAGE_ORDER}
        if not config.dedup_enabled:
            stage_map["deduped"].status = "skipped"
        if not config.quality_enabled:
            stage_map["filtered"].status = "skipped"
        if not config.pii_enabled:
            stage_map["redacted"].status = "skipped"
        manifest.stages = [stage_map[s] for s in STAGE_ORDER]
        manifest.source_docs = len(raw_docs)
        manifest.total_bytes_written = 0

        # Active (non-skipped) stages in run order. Mark the first "running"
        # before any work begins so the polling UI shows the currently-computing
        # stage instead of a wall of "pending"; the marker then advances to the
        # next active stage as each one completes.
        active_stages = [s for s in STAGE_ORDER if stage_map[s].status != "skipped"]
        if active_stages:
            stage_map[active_stages[0]].status = "running"
        manifest.updated_at = now()
        save(manifest)

        current_in = len(raw_docs)
        for out in curator.run_stages(raw_docs, config):
            sr = stage_map[out.stage]
            shard_count, bytes_written = _write_stage_shards(run_id, out.stage, out.docs)
            sr.status = "completed"
            sr.docs_in = len(raw_docs) if out.stage == "raw" else current_in
            sr.docs_out = len(out.docs)
            sr.docs_removed = out.docs_removed
            sr.pii_spans_redacted = out.pii_spans_redacted
            sr.bytes_written = bytes_written
            sr.shard_count = shard_count
            sr.detail = out.detail
            manifest.total_bytes_written += bytes_written
            # Advance the "running" marker to the next active stage, if any.
            idx = active_stages.index(out.stage)
            if idx + 1 < len(active_stages):
                stage_map[active_stages[idx + 1]].status = "running"
            manifest.updated_at = now()
            save(manifest)
            current_in = len(out.docs)

        manifest.status = "completed"
        manifest.error = None
        manifest.updated_at = now()
        save(manifest)
        logger.info("Curation run completed: run_id=%s", run_id)
    except curator.CuratorEngineNotInstalled as e:
        logger.warning("Run %s failed — engine missing: %s", run_id, e.detail)
        _fail(run_id, e.detail)
    except (RunValidationError, RunNotFoundError) as e:
        _fail(run_id, e.detail)
    except Exception as e:
        logger.exception("Curation run %s failed", run_id)
        _fail(run_id, f"Curation failed: {e}")
    finally:
        with _running_lock:
            _running.discard(run_id)
