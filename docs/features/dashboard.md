<!-- last_verified: 2026-07-31 -->
# Feature: Dashboard

## Purpose
Give an at-a-glance overview of curation activity — how much corpus has been processed, how much was pruned, how much PII was redacted, and how many bytes the versioned stages wrote to B2.

## Used By
- UI: `/` page (dashboard home)
- API: `GET /runs/stats`

## Core Functions
- `apps/web/src/components/dashboard/curation-stats-cards.tsx` — the five stat cards (plus the on-screen loading notice while manifests aggregate)
- `apps/web/src/components/dashboard/stage-funnel-chart.tsx` — per-stage funnel (docs raw → deduped → filtered → redacted)
- `apps/web/src/components/dashboard/recent-runs-table.tsx` — recent runs (name, status, source, docs-in→out, when)
- `apps/web/src/lib/queries.ts` — `useRunStats()` TanStack Query hook
- `apps/web/src/lib/api-client.ts` — `getRunStats()`
- `services/api/app/runtime/runs.py` — `GET /runs/stats` handler
- `services/api/app/service/runs.py` — `get_run_stats()` aggregation over every run manifest
- `services/api/app/repo/runs_store.py` — `list_run_ids()` + `get_manifest()` data access

## Canonical Files
- Dashboard stat cards: `apps/web/src/components/dashboard/curation-stats-cards.tsx`
- Stats aggregation: `services/api/app/service/runs.py` (`get_run_stats`)

## Inputs
- None (dashboard loads data automatically on page load)

## Outputs
- `GET /runs/stats` → `RunStats`:
  - `total_runs: int`
  - `documents_processed: int` (sum of raw/source docs across runs)
  - `documents_removed: int` (dedup + quality-filter removals)
  - `pii_spans_redacted: int`
  - `total_bytes_written: int` + `total_bytes_human: str` — the write-amplification total across every stage of every run
  - `funnel: FunnelPoint[]` — `{stage, label, documents}` for raw → deduped → filtered → redacted
  - `recent: RunSummary[]` — recent runs for the table

## Flow
- Page loads → a single `GET /runs/stats` call via `useRunStats()`
- `get_run_stats()` lists every run under the app prefix (`runs_store.list_run_ids`), reads each `manifest.json`, and folds the per-stage `StageResult` numbers into the five aggregates + the funnel
- Stat cards render total runs, documents processed, documents removed, PII spans redacted, and total bytes written to B2
- The funnel chart shows document counts falling from raw through each enabled stage
- The recent-runs table shows the latest runs with a status badge; each row links to `/runs/[id]`

## Edge Cases
- API unavailable → error state with retry (inline `ErrorState`)
- No runs yet → zeroed cards, empty funnel message, empty table message
- A run still executing → its partial per-stage numbers are included as its manifest is re-saved after each stage; totals converge as it completes
- A failed run → contributes whatever stages completed before failure; the recent-runs table surfaces its `failed` status badge

## UX States
- Loading: skeleton placeholders for the cards, funnel, and table
- Empty: "No curation runs yet" prompt to create one on `/runs`
- Loaded: populated cards, funnel chart, recent-runs table

## Verification
- Test files: `services/api/tests/` run-stats coverage (aggregation over manifests, empty-state, mixed run statuses)
- Required cases: stats with runs, stats with no runs, aggregation across multiple runs, API error fallback
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Curation Runs](curation-runs.md)
- [Lineage & Versioned B2 Stages](lineage-and-b2-layout.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [App Workflows](../app-workflows.md)
