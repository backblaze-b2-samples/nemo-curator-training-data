<!-- last_verified: 2026-07-31 -->
# Feature: Lineage & Versioned B2 Stages

## Purpose
Make every curation stage an independent, versioned, sharded set in B2 and track its lineage in a per-run manifest — so the corpus is audit-ready and the write-amplification cost is explicit. *This is the feature that makes B2 the star.*

## Used By
- UI: `/runs/[id]` (per-stage docs-in/out + bytes, total bytes written), the dashboard (`Total bytes written to B2` + funnel), and the Corpus Explorer (`/corpus`)
- API: `GET /runs/detail` (manifest), `GET /runs/stats` (aggregates)

## Core Functions
- `services/api/app/repo/runs_store.py` — `manifest_key`, `run_prefix`, `stage_prefix`, `shard_key`, `put_manifest`, `put_shard`
- `services/api/app/service/run_engine.py` — `run_pipeline` re-saves the manifest after each stage and accumulates `total_bytes_written`
- `services/api/app/types/runs.py` — `RunManifest`, `StageResult`

## Canonical Files
- B2 layout + persistence: `services/api/app/repo/runs_store.py`

## Inputs
- Each stage's output documents `[{id, text}]` and its `StageResult` stats

## Outputs
- Per-run B2 objects (app prefix `nemo-curator/`, default):

```
nemo-curator/runs/<run_id>/manifest.json
nemo-curator/runs/<run_id>/stages/raw/part-00000.jsonl
nemo-curator/runs/<run_id>/stages/deduped/part-*.jsonl
nemo-curator/runs/<run_id>/stages/filtered/part-*.jsonl
nemo-curator/runs/<run_id>/stages/redacted/part-*.jsonl
```

- `manifest.json` = `RunManifest`: config, status, per-stage `StageResult`s (docs_in/out, docs_removed, pii_spans_redacted, bytes_written, shard_count), `source_docs`, `total_bytes_written`, timestamps

## Flow
- On execute, `run_pipeline` writes the `raw` stage verbatim, then each enabled stage in order (`raw → deduped → filtered → redacted`)
- Each stage's docs are sharded at `SHARD_SIZE = 25` and written with `put_shard`; the manifest is re-saved after every stage so the polling UI shows live lineage
- `total_bytes_written` sums every stage's bytes — `raw + deduped + filtered + redacted` can be up to 4× the corpus (the write-amplification story)
- There is no application database: `manifest.json` is the durable source of truth

## Edge Cases
- An empty stage still writes one empty shard so the stage exists in the layout and lineage is unbroken
- A run that fails mid-pipeline leaves the completed stages' shards + a `failed` manifest with an `error` — partial lineage is preserved, not rolled back
- Delete is scoped strictly to `nemo-curator/runs/<run_id>/` — it can never touch another run's or app's data in a shared bucket
- Bucket changed outside the app → the app's own writes are authoritative; the manifest reflects what this run wrote

## UX States
- Detail: a per-stage table with docs-in → docs-out, removed/redacted counts, shard count, and bytes
- Dashboard: `Total bytes written to B2` card + per-stage funnel

## Verification
- Test files: `services/api/tests/` run-store + lineage tests
- Required cases: manifest round-trip, per-stage shard keys, total-bytes accumulation, delete scoping to the run prefix
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Curation Runs](curation-runs.md), [Corpus Explorer](corpus-explorer.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md) (B2 layout + engine split)
