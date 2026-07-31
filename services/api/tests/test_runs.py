"""Curation-run surface tests.

Drives the /runs routes and the pipeline engine against an in-memory stand-in
for the B2 store, so no credentials or network are needed. The NeMo Curator
engine is genuinely absent in the credential-free gate, so the execute path is
tested for graceful degradation (the run is failed with the install hint, never
crashed).
"""

import pytest

from app.repo import curator, runs_store
from app.service import run_engine


@pytest.fixture
def memory_store(monkeypatch):
    """Replace the B2-backed runs_store with an in-memory dict store."""
    manifests: dict[str, dict] = {}
    shards: dict[str, bytes] = {}

    monkeypatch.setattr(runs_store, "put_manifest", lambda rid, data: manifests.__setitem__(rid, data))
    monkeypatch.setattr(runs_store, "get_manifest", lambda rid: manifests.get(rid))
    monkeypatch.setattr(runs_store, "list_run_ids", lambda: list(manifests))

    def _delete(rid):
        removed = 1 if manifests.pop(rid, None) is not None else 0
        for key in [k for k in shards if k.startswith(runs_store.run_prefix(rid))]:
            del shards[key]
        return removed

    monkeypatch.setattr(runs_store, "delete_run", _delete)

    def _put_shard(rid, stage, index, body):
        key = runs_store.shard_key(rid, stage, index)
        shards[key] = body
        return key

    monkeypatch.setattr(runs_store, "put_shard", _put_shard)

    def _list_shards(rid, stage):
        prefix = runs_store.stage_prefix(rid, stage)
        out = []
        for key, body in shards.items():
            if key.startswith(prefix):
                out.append(
                    {
                        "key": key,
                        "filename": key.rsplit("/", 1)[-1],
                        "size": len(body),
                        "size_human": f"{len(body)} B",
                    }
                )
        return sorted(out, key=lambda o: o["key"])

    monkeypatch.setattr(runs_store, "list_shards", _list_shards)
    monkeypatch.setattr(
        runs_store, "get_object_text", lambda key: shards[key].decode("utf-8")
    )
    return manifests, shards


async def test_create_read_update_delete_run(client, memory_store):
    payload = {"name": "First run", "config": {"source": "demo"}}
    created = (await client.post("/runs", json=payload)).json()
    assert created["status"] == "pending"
    assert created["name"] == "First run"
    run_id = created["run_id"]

    listed = (await client.get("/runs")).json()
    assert any(r["run_id"] == run_id for r in listed)

    detail = (await client.get(f"/runs/detail?run_id={run_id}")).json()
    assert detail["config"]["source"] == "demo"
    assert len(detail["stages"]) == 4  # raw, deduped, filtered, redacted

    patched = (
        await client.patch(f"/runs?run_id={run_id}", json={"name": "Renamed"})
    ).json()
    assert patched["name"] == "Renamed"

    deleted = await client.delete(f"/runs?run_id={run_id}")
    assert deleted.status_code == 200
    assert (await client.get(f"/runs/detail?run_id={run_id}")).status_code == 404


async def test_detail_missing_run_is_404(client, memory_store):
    assert (await client.get("/runs/detail?run_id=nope")).status_code == 404


async def test_stats_empty(client, memory_store):
    stats = (await client.get("/runs/stats")).json()
    assert stats["total_runs"] == 0
    assert [f["stage"] for f in stats["funnel"]] == [
        "raw",
        "deduped",
        "filtered",
        "redacted",
    ]


def test_execute_without_engine_fails_gracefully(memory_store, monkeypatch):
    """Executing a run with the NeMo Curator engine absent must fail the run
    with the install hint — never crash."""
    manifests, _ = memory_store
    monkeypatch.setattr(curator, "engine_available", lambda: False)

    from app.service.runs import create_run
    from app.types.runs import CreateRunRequest

    manifest = create_run(CreateRunRequest(name="engine test"))
    run_engine.run_pipeline(manifest.run_id)  # synchronous, no thread

    failed = manifests[manifest.run_id]
    assert failed["status"] == "failed"
    assert "requirements-curator.txt" in failed["error"]


def test_shard_key_layout_is_scoped():
    """Every write key stays under the app prefix so deletes can't escape it."""
    key = runs_store.shard_key("abc123", "deduped", 0)
    assert key == "nemo-curator/runs/abc123/stages/deduped/part-00000.jsonl"
    assert key.startswith(runs_store.run_prefix("abc123"))
