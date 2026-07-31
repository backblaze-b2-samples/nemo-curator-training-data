<!-- last_verified: 2026-07-31 -->
# Feature: Quality Filtering

## Purpose
Score and prune low-quality documents (too short, too symbol-heavy, too repetitive) using NeMo Curator's heuristic filters, and write the surviving documents as their own versioned stage in B2.

## Used By
- UI: `/runs` create form — the **Quality filter** switch + **Quality preset** selector; results on `/runs/[id]` (the `filtered` stage row) and in the Corpus Explorer
- API: part of `POST /runs/execute` (runs after `deduped`)

## Core Functions
- `services/api/app/repo/curator.py` — `run_stages` quality branch: a NeMo Curator `Sequential` of `ScoreFilter`s over `WordCountFilter`, `MeanWordLengthFilter`, `SymbolsToWordsFilter`, `NonAlphaNumericFilter`, `RepeatedLinesFilter`
- `QUALITY_PRESETS` in `curator.py` — threshold sets for `lenient` / `standard` / `strict`
- `services/api/app/service/run_engine.py` — writes the `filtered` shards and records `docs_removed`

## Canonical Files
- Engine adapter + preset thresholds: `services/api/app/repo/curator.py`

## Inputs
- `RunConfig.quality_enabled: bool`
- `RunConfig.quality_preset`: `lenient` | `standard` (default) | `strict`
- The upstream stage's documents (deduped if dedup ran, else raw)

## Outputs
- `nemo-curator/runs/<run_id>/stages/filtered/part-*.jsonl` — documents passing all heuristic filters
- `StageResult(stage="filtered")` with `docs_in`, `docs_out`, `docs_removed`, `bytes_written`, `shard_count`, `detail`

## Flow
- If `quality_enabled`, the preset selects thresholds (min/max words, max symbol-to-word ratio, max non-alphanumeric ratio, max repeated-line fraction)
- The `Sequential(ScoreFilter(...))` pipeline scores and drops documents failing any filter — all CPU, no model download
- `run_engine` shards the survivors and streams them to B2, updating the manifest

## Edge Cases
- `quality_enabled = false` → the `filtered` stage is marked `skipped`; the next stage reads from the upstream stage
- All documents pass → `docs_removed = 0`
- All documents pruned → an empty stage still writes one empty shard so lineage is preserved (see run_engine `_write_stage_shards`)
- Classifier-based (model) filtering is an optional GPU path and is intentionally **not** the default; only heuristic CPU filters ship enabled
- Engine not installed → the run fails gracefully with the install hint

## UX States
- Form: a Switch (on by default) + a Select for preset with a Standard default hint
- Detail: the `filtered` row shows docs-in → docs-out and the preset in `detail`, or a "skipped" badge

## Verification
- Test files: `services/api/tests/` curation stage tests
- Required cases: standard preset prunes a known low-quality doc, quality disabled skips the stage, preset threshold mapping
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Curation Runs](curation-runs.md), [Deduplication](deduplication.md), [PII Redaction](pii-redaction.md)
- [Lineage & Versioned B2 Stages](lineage-and-b2-layout.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md)
