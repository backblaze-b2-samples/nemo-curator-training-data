"""Curation-run REST routes.

Thin handlers over `service.runs` — no business logic here. Route shapes mirror
the starter's query-param design (`/runs/detail?run_id=`) to avoid `/{id}`
route collisions, matching the `files-by-key` pattern.

These routes are intentionally UNAUTHENTICATED and single-tenant (see
docs/SECURITY.md). Deletes are scoped by the repo layer strictly to the run's
own B2 prefix, so a delete can never touch another run's or app's data.
"""

import logging

from fastapi import APIRouter, HTTPException

from app.service.runs import (
    RunBusyError,
    RunNotFoundError,
    RunValidationError,
    create_run,
    delete_run,
    execute_run,
    get_run,
    get_run_stats,
    list_run_shards,
    list_runs,
    preview_document,
    shard_download_url,
    update_run,
)
from app.types.runs import (
    CreateRunRequest,
    DocumentPreview,
    RunManifest,
    RunStats,
    RunSummary,
    ShardDownload,
    ShardList,
    StageName,
    UpdateRunRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _map_errors(exc: Exception) -> HTTPException:
    if isinstance(exc, RunNotFoundError):
        return HTTPException(status_code=404, detail=exc.detail)
    if isinstance(exc, RunBusyError):
        return HTTPException(status_code=409, detail=exc.detail)
    if isinstance(exc, RunValidationError):
        return HTTPException(status_code=400, detail=exc.detail)
    return HTTPException(status_code=502, detail="Storage backend error")


@router.get("/runs", response_model=list[RunSummary])
def list_runs_endpoint():
    try:
        return list_runs()
    except RuntimeError as e:
        raise _map_errors(e) from None


@router.post("/runs", response_model=RunManifest)
def create_run_endpoint(req: CreateRunRequest):
    try:
        return create_run(req)
    except RuntimeError as e:
        raise _map_errors(e) from None


@router.get("/runs/detail", response_model=RunManifest)
def run_detail_endpoint(run_id: str):
    try:
        return get_run(run_id)
    except (RunNotFoundError, RuntimeError) as e:
        raise _map_errors(e) from None


@router.patch("/runs", response_model=RunManifest)
def update_run_endpoint(run_id: str, req: UpdateRunRequest):
    try:
        return update_run(run_id, req)
    except (RunNotFoundError, RunBusyError, RunValidationError, RuntimeError) as e:
        raise _map_errors(e) from None


@router.delete("/runs")
def delete_run_endpoint(run_id: str):
    try:
        deleted = delete_run(run_id)
    except (RunNotFoundError, RunBusyError, RuntimeError) as e:
        raise _map_errors(e) from None
    logger.info("Curation run deleted: run_id=%s objects=%d", run_id, deleted)
    return {"deleted": deleted, "run_id": run_id}


@router.post("/runs/execute", response_model=RunManifest)
def execute_run_endpoint(run_id: str):
    try:
        return execute_run(run_id)
    except (RunNotFoundError, RunBusyError, RuntimeError) as e:
        raise _map_errors(e) from None


@router.get("/runs/shards", response_model=ShardList)
def run_shards_endpoint(run_id: str, stage: StageName):
    try:
        return list_run_shards(run_id, stage)
    except (RunNotFoundError, RuntimeError) as e:
        raise _map_errors(e) from None


@router.get("/runs/document", response_model=DocumentPreview)
def run_document_endpoint(run_id: str, stage: StageName, shard: str, limit: int = 20):
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    try:
        return preview_document(run_id, stage, shard, limit)
    except (RunNotFoundError, RunValidationError, RuntimeError) as e:
        raise _map_errors(e) from None


@router.get("/runs/shard-download", response_model=ShardDownload)
def run_shard_download_endpoint(run_id: str, stage: StageName, shard: str):
    try:
        return shard_download_url(run_id, stage, shard)
    except (RunNotFoundError, RunValidationError, RuntimeError) as e:
        raise _map_errors(e) from None


@router.get("/runs/stats", response_model=RunStats)
def run_stats_endpoint():
    try:
        return get_run_stats()
    except RuntimeError as e:
        raise _map_errors(e) from None
