<!-- last_verified: 2026-07-31 -->
# Feature: Deduplication

## Purpose
Remove duplicate documents from a raw corpus so downstream training doesn't overweight repeated text, and write the deduplicated result as its own versioned stage in B2.

## Used By
- UI: `/runs` create form — the **Deduplicate** switch + **Dedup mode** selector; results on `/runs/[id]` (the `deduped` stage row) and in the Corpus Explorer
- API: part of `POST /runs/execute` (runs as the first optional stage after `raw`)

## Core Functions
- `services/api/app/repo/curator.py` — `run_stages` dedup branch using NeMo Curator's `ExactDuplicates(id_field, text_field, hash_method="md5")`
- `services/api/app/service/run_engine.py` — writes the `deduped` shards and records `docs_removed`

## Canonical Files
- Engine adapter: `services/api/app/repo/curator.py`

## Inputs
- `RunConfig.dedup_enabled: bool`
- `RunConfig.dedup_mode`: `exact` (default) | `exact_fuzzy`
- The `raw` documents `[{id, text}]` loaded from the run source

## Outputs
- `nemo-curator/runs/<run_id>/stages/deduped/part-*.jsonl` — deduplicated documents
- `StageResult(stage="deduped")` with `docs_in`, `docs_out`, `docs_removed`, `bytes_written`, `shard_count`, `detail`

## Flow
- If `dedup_enabled`, `ExactDuplicates` hashes each document (MD5) and identifies duplicate ids
- The engine keeps the non-duplicate rows, materializes `[{id, text}]`, and yields a `deduped` `StageOutput` with the removed count
- `run_engine` shards the kept docs (`SHARD_SIZE = 25`) and streams them to B2, updating the manifest

## Edge Cases
- `dedup_enabled = false` → the `deduped` stage is marked `skipped`; the next stage reads from `raw`
- No duplicates present → `docs_removed = 0`, all docs pass through (still written as a versioned stage)
- **Fuzzy dedup** (`exact_fuzzy`) is GPU-only via RAPIDS — offered as a labeled, disabled "requires CUDA GPU" option in the form, not the default. On a CPU run the mode is recorded in `detail` but the exact path still governs removals.
- Engine not installed → the whole run fails gracefully with the install hint

## UX States
- Form: a Switch (on by default) + a Select for mode; the fuzzy option is disabled/labeled when no GPU
- Detail: the `deduped` row shows docs-in → docs-out and removed count, or a "skipped" badge

## Verification
- Test files: `services/api/tests/` curation stage tests (engine-present cases run only where the engine is installed)
- Required cases: exact dedup removes a known duplicate, dedup disabled skips the stage, removed-count bookkeeping
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Curation Runs](curation-runs.md), [Quality Filtering](quality-filtering.md)
- [Lineage & Versioned B2 Stages](lineage-and-b2-layout.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md)
