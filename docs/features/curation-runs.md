<!-- last_verified: 2026-07-31 -->
# Feature: Curation Runs

## Purpose
Create, configure, run, inspect, edit, and delete a multi-stage NeMo Curator pipeline over a raw corpus. This is the app's primary entity.

## Used By
- UI: `/runs` (list + "New run"), `/runs/[id]` (detail / read + edit + delete + run)
- API: `GET /runs`, `POST /runs`, `GET /runs/detail?run_id=`, `PATCH /runs?run_id=`, `DELETE /runs?run_id=`, `POST /runs/execute?run_id=`
- Job: `service/run_engine.run_pipeline` — background thread that executes the configured stages

## Core Functions
- `services/api/app/runtime/runs.py` — REST handlers (thin, no logic)
- `services/api/app/service/runs.py` — `create_run`, `get_run`, `update_run`, `delete_run`, `execute_run`, `list_runs`
- `services/api/app/service/run_engine.py` — `run_pipeline`, `load_source`, manifest load/save, in-process `_running` guard
- `services/api/app/repo/runs_store.py` — manifest + shard persistence on B2
- `apps/web/src/components/runs/run-form.tsx` (+ `run-create-dialog.tsx`, `run-edit-dialog.tsx`, `run-detail.tsx`, `run-list.tsx`, `run-delete-button.tsx`, `run-status-badge.tsx`)
- `apps/web/src/lib/queries.ts` — `useRuns`, `useRunDetail`, `useCreateRun`, `useUpdateRun`, `useDeleteRun`, `useExecuteRun`

## Canonical Files
- Orchestration: `services/api/app/service/runs.py`
- Create/edit form (selector + hint patterns): `apps/web/src/components/runs/run-form.tsx`

## Inputs
- `CreateRunRequest`: `name: str` (free text, 1–120 chars) + `config: RunConfig`
- `RunConfig`: `source` (`demo` | `b2_prefix`), `source_prefix` (when `b2_prefix`), `dedup_enabled` / `quality_enabled` / `pii_enabled` (switches), `dedup_mode` (`exact` | `exact_fuzzy`), `quality_preset` (`lenient` | `standard` | `strict`), `pii_entities` (finite checkbox set), `redaction_mode` (`replace` | `mask` | `hash`)
- `UpdateRunRequest`: optional `name` and/or `config` (edit allowed only when the run is not executing)

## Outputs
- `RunManifest` persisted as `nemo-curator/runs/<run_id>/manifest.json` (status, config, per-stage `StageResult`s, `source_docs`, `total_bytes_written`, timestamps, `error`)
- Side effects: stage shards written to B2 on execute; manifest + shards deleted on delete (scoped to the run's prefix)

## Flow
- **create** → `POST /runs` writes a `pending` manifest (no stages executed yet); the detail page reads this as "Not run yet — click Run pipeline to start" rather than zeroed source/byte totals
- **read** → `GET /runs/detail` returns config, status, per-stage docs-in/out + bytes, lineage
- **edit** → `PATCH /runs` updates name/config; rejected with 409 if the run is currently executing
- **run** → `POST /runs/execute` marks the manifest `running`, launches `run_pipeline` in a background thread, and returns immediately; the UI polls `GET /runs/detail` for live per-stage progress
- **delete** → `DELETE /runs` removes the manifest and every stage shard, strictly scoped to the run's prefix

## Edge Cases
- Curation engine not installed → the run is marked `failed` with the install hint (see [PII Redaction](pii-redaction.md) / ARCHITECTURE engine-split); the app never crashes
- Execute while already running → 409 `RunBusyError`
- Edit/delete while running → 409 `RunBusyError`
- Unknown `run_id` → 404 `RunNotFoundError`
- `source = b2_prefix` with no `source_prefix`, or a prefix that yields no documents → 400 `RunValidationError`
- B2 unreachable → 502

## UX States
- Empty: `/runs` shows "No runs yet" with a "New run" button
- Loading: skeleton list / detail
- Not run yet: a `pending` run reads "Not run yet — click Run pipeline to start" and its four stage cards sit `pending`
- Running: status badge polls; the currently-computing stage shows a `running` badge with an animated spinner, and per-stage rows fill in as each stage completes
- Error: failed status badge + the manifest `error` message surfaced on the detail page

## Verification
- Test files: `services/api/tests/` run lifecycle + structural tests
- Required cases: create → read, edit config, execute (engine-absent graceful failure), delete scoping, busy/404/validation errors
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Deduplication](deduplication.md), [Quality Filtering](quality-filtering.md), [PII Redaction](pii-redaction.md)
- [Lineage & Versioned B2 Stages](lineage-and-b2-layout.md), [Corpus Explorer](corpus-explorer.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md), [App Workflows](../app-workflows.md)
