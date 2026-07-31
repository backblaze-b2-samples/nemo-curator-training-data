<!-- last_verified: 2026-07-31 -->
# Feature: Corpus Explorer

## Purpose
Browse a curation run's curated shards by stage — scoped to the app's own B2 prefix — with per-shard sizes, a first-N-documents preview, and a download link. This is the sample-specific scoped explorer that coexists with (never replaces) the full-bucket `/files` browser.

## Used By
- UI: `/corpus` page (`apps/web/src/components/corpus/corpus-explorer.tsx`)
- API: `GET /runs/shards?run_id=&stage=`, `GET /runs/document?run_id=&stage=&shard=&limit=`, `GET /runs/shard-download?run_id=&stage=&shard=`

## Core Functions
- `services/api/app/runtime/runs.py` — `run_shards_endpoint`, `run_document_endpoint`, `run_shard_download_endpoint`
- `services/api/app/service/runs.py` — `list_run_shards`, `preview_document`, `shard_download_url`
- `services/api/app/repo/runs_store.py` — `list_shards`, `get_object_text`, `presign_shard`
- `apps/web/src/lib/queries.ts` — `useRunShards`, `useRunDocument` hooks

## Canonical Files
- Scoped explorer UI: `apps/web/src/components/corpus/corpus-explorer.tsx`
- Shard listing/preview data access: `services/api/app/repo/runs_store.py`

## Inputs
- `run_id: str`, `stage: StageName` (`raw` | `deduped` | `filtered` | `redacted`)
- `shard: str` (shard filename) + `limit: int` (1–200, default 20) for preview

## Outputs
- `ShardList`: `{run_id, stage, shards: [{key, filename, size_bytes, size_human}]}`
- `DocumentPreview`: `{run_id, stage, shard, documents: [...], returned, truncated}`
- `ShardDownload`: `{url}` — a presigned GET (attachment disposition)

## Flow
- User picks a run and a stage → `GET /runs/shards` lists that stage's shards (via `list_objects_v2` under `nemo-curator/runs/<run_id>/stages/<stage>/`)
- Selecting a shard → `GET /runs/document` reads the first N JSONL lines (`get_object_text`) and returns them as a preview
- "Download" → `GET /runs/shard-download` returns a presigned URL for the shard

## Edge Cases
- Run or stage with no shards (e.g. a skipped stage) → empty shard list
- `limit` outside 1–200 → 400
- A stage that produced an empty shard → preview returns 0 documents, `truncated = false`
- Unknown `run_id` → 404; B2 unreachable → 502
- Reads are strictly under the app prefix — the explorer cannot reach other prefixes (that is what the full `/files` browser is for)

## UX States
- Empty: "No shards for this stage" (e.g. skipped stage)
- Loading: skeletons while shards/preview load
- Loaded: shard list with sizes; expanding a shard shows the document preview and a download action

## Verification
- Test files: `services/api/tests/` shard-listing + preview tests
- Required cases: list shards for a stage, preview first-N docs with limit bounds, presigned download URL shape, skipped-stage empty list
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Curation Runs](curation-runs.md), [Lineage & Versioned B2 Stages](lineage-and-b2-layout.md)
- [File Browser](file-browser.md) (the full-bucket explorer this one coexists with)
- [ARCHITECTURE.md](../../ARCHITECTURE.md)
