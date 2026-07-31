"""B2 (S3-compatible) persistence for curation runs.

All curation state — run manifests and every stage's sharded JSONL output —
lives in B2 under the app's own prefix (`settings.app_prefix`, default
`nemo-curator/`). There is no application database. boto3 stays confined to the
repo/ layer; this module reuses the cached, custom-user-agent S3 client from
`b2_client` for connection pooling.

Layout::

    <app_prefix>runs/<run_id>/manifest.json
    <app_prefix>runs/<run_id>/stages/<stage>/part-00000.jsonl
"""

import json

from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings
from app.repo.b2_client import get_presigned_url, get_s3_client
from app.types.formatting import humanize_bytes


def _runs_root() -> str:
    return f"{settings.app_prefix}runs/"


def run_prefix(run_id: str) -> str:
    return f"{_runs_root()}{run_id}/"


def manifest_key(run_id: str) -> str:
    return f"{run_prefix(run_id)}manifest.json"


def stage_prefix(run_id: str, stage: str) -> str:
    return f"{run_prefix(run_id)}stages/{stage}/"


def shard_key(run_id: str, stage: str, index: int) -> str:
    return f"{stage_prefix(run_id, stage)}part-{index:05d}.jsonl"


def put_manifest(run_id: str, data: dict) -> None:
    """Write a run's manifest.json. Raises RuntimeError on S3 failure."""
    body = json.dumps(data, indent=2, default=str).encode("utf-8")
    client = get_s3_client()
    try:
        client.put_object(
            Bucket=settings.b2_bucket_name,
            Key=manifest_key(run_id),
            Body=body,
            ContentType="application/json",
        )
    except (ClientError, BotoCoreError) as e:
        raise RuntimeError(f"B2 manifest write failed for run '{run_id}': {e}") from e


def get_manifest(run_id: str) -> dict | None:
    """Read a run's manifest.json, or None if it does not exist."""
    client = get_s3_client()
    try:
        response = client.get_object(
            Bucket=settings.b2_bucket_name, Key=manifest_key(run_id)
        )
        return json.loads(response["Body"].read())
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey"):
            return None
        raise RuntimeError(f"B2 manifest read failed for run '{run_id}': {e}") from e
    except BotoCoreError as e:
        raise RuntimeError(f"B2 manifest read failed for run '{run_id}': {e}") from e


def list_run_ids() -> list[str]:
    """Every run_id under the app prefix (one CommonPrefix per run dir)."""
    client = get_s3_client()
    root = _runs_root()
    ids: list[str] = []
    kwargs: dict = {
        "Bucket": settings.b2_bucket_name,
        "Prefix": root,
        "Delimiter": "/",
        "MaxKeys": 1000,
    }
    try:
        while True:
            response = client.list_objects_v2(**kwargs)
            for cp in response.get("CommonPrefixes", []):
                # "<app_prefix>runs/<run_id>/" -> "<run_id>"
                run_id = cp["Prefix"][len(root) :].rstrip("/")
                if run_id:
                    ids.append(run_id)
            if not response.get("IsTruncated"):
                break
            kwargs["ContinuationToken"] = response["NextContinuationToken"]
    except (ClientError, BotoCoreError) as e:
        raise RuntimeError(f"B2 run listing failed: {e}") from e
    return ids


def _list_keys(prefix: str) -> list[dict]:
    """All objects under `prefix` as [{key, size}] (paginated)."""
    client = get_s3_client()
    out: list[dict] = []
    kwargs: dict = {
        "Bucket": settings.b2_bucket_name,
        "Prefix": prefix,
        "MaxKeys": 1000,
    }
    try:
        while True:
            response = client.list_objects_v2(**kwargs)
            for obj in response.get("Contents", []):
                out.append({"key": obj["Key"], "size": obj["Size"]})
            if not response.get("IsTruncated"):
                break
            kwargs["ContinuationToken"] = response["NextContinuationToken"]
    except (ClientError, BotoCoreError) as e:
        raise RuntimeError(f"B2 list failed for '{prefix}': {e}") from e
    return out


def list_prefix_objects(prefix: str) -> list[dict]:
    """Public wrapper for listing raw source objects under an arbitrary prefix."""
    return _list_keys(prefix)


def delete_run(run_id: str) -> int:
    """Delete a run's manifest and ALL its stage shards.

    SAFETY: strictly scoped to `<app_prefix>runs/<run_id>/`. Only keys that
    start with that exact prefix are ever passed to delete_objects, so a run
    delete can never touch another run's data or any non-app prefix in a shared
    bucket. Returns the number of objects deleted.
    """
    prefix = run_prefix(run_id)
    objects = _list_keys(prefix)
    keys = [o["key"] for o in objects if o["key"].startswith(prefix)]
    if not keys:
        return 0
    client = get_s3_client()
    deleted = 0
    try:
        for i in range(0, len(keys), 1000):
            batch = [{"Key": k} for k in keys[i : i + 1000]]
            client.delete_objects(
                Bucket=settings.b2_bucket_name,
                Delete={"Objects": batch, "Quiet": True},
            )
            deleted += len(batch)
    except (ClientError, BotoCoreError) as e:
        raise RuntimeError(f"B2 delete failed for run '{run_id}': {e}") from e
    return deleted


def put_shard(run_id: str, stage: str, index: int, body: bytes) -> str:
    """Write one stage shard (JSONL). Returns the object key."""
    key = shard_key(run_id, stage, index)
    client = get_s3_client()
    try:
        client.put_object(
            Bucket=settings.b2_bucket_name,
            Key=key,
            Body=body,
            ContentType="application/x-ndjson",
        )
    except (ClientError, BotoCoreError) as e:
        raise RuntimeError(f"B2 shard write failed for '{key}': {e}") from e
    return key


def list_shards(run_id: str, stage: str) -> list[dict]:
    """Shards for one run/stage as [{key, filename, size}], sorted by key."""
    objects = _list_keys(stage_prefix(run_id, stage))
    for o in objects:
        o["filename"] = o["key"].rsplit("/", 1)[-1]
        o["size_human"] = humanize_bytes(o["size"])
    objects.sort(key=lambda o: o["key"])
    return objects


def get_object_text(key: str) -> str:
    """Download an object body as UTF-8 text. Raises RuntimeError on failure."""
    client = get_s3_client()
    try:
        response = client.get_object(Bucket=settings.b2_bucket_name, Key=key)
        return response["Body"].read().decode("utf-8", errors="replace")
    except (ClientError, BotoCoreError) as e:
        raise RuntimeError(f"B2 read failed for '{key}': {e}") from e


def presign_shard(key: str, filename: str | None = None) -> str:
    """Presigned GET URL for a shard download (attachment disposition)."""
    return get_presigned_url(key, filename=filename, disposition="attachment")
