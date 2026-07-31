<!-- last_verified: 2026-07-31 -->
# Feature: PII Redaction

## Purpose
Detect and redact personally identifiable information (emails, phones, names, SSNs, credit cards, IPs) from documents using NeMo Curator's Presidio-backed modifier, and write the clean result as the final versioned stage in B2.

## Used By
- UI: `/runs` create form — the **PII redact** switch, the **PII entities** checkbox group, and the **Redaction mode** selector; results on `/runs/[id]` (the `redacted` stage row) and in the Corpus Explorer
- API: part of `POST /runs/execute` (runs last, after `filtered`)

## Core Functions
- `services/api/app/repo/curator.py` — `run_stages` PII branch using NeMo Curator's `Modify(PiiModifier(...))` over Presidio; `_count_pii_spans` uses the same Presidio `AnalyzerEngine` to count spans
- `REDACTION_ACTIONS` in `curator.py` — maps `replace` / `mask` / `hash` to the `PiiModifier` anonymize action
- `services/api/app/service/run_engine.py` — writes the `redacted` shards and records `pii_spans_redacted`

## Canonical Files
- Engine adapter: `services/api/app/repo/curator.py`

## Inputs
- `RunConfig.pii_enabled: bool`
- `RunConfig.pii_entities`: finite set — `EMAIL_ADDRESS`, `PHONE_NUMBER`, `PERSON`, `US_SSN`, `CREDIT_CARD`, `IP_ADDRESS` (default: EMAIL, PHONE, PERSON, US_SSN)
- `RunConfig.redaction_mode`: `replace` (default) | `mask` | `hash`
- The upstream stage's documents (filtered if quality ran, else deduped/raw)

## Outputs
- `nemo-curator/runs/<run_id>/stages/redacted/part-*.jsonl` — PII-redacted documents
- `StageResult(stage="redacted")` with `docs_in`, `docs_out`, `pii_spans_redacted`, `bytes_written`, `shard_count`, `detail`

## Flow
- If `pii_enabled`, the engine first counts PII spans across the incoming documents for the selected entities (`_count_pii_spans`)
- `PiiModifier(language="en", supported_entities=..., anonymize_action=..., device=backend)` detects and rewrites PII using spaCy `en_core_web_lg` NER under Presidio (CPU)
- `run_engine` shards the redacted docs and streams them to B2, updating the manifest with the span count

## Edge Cases
- `pii_enabled = false` → the `redacted` stage is marked `skipped`
- Presidio analyzer can't be built (e.g. model missing) → span count degrades to 0 rather than failing the run (best-effort count); redaction itself still runs via the modifier
- Demo corpus uses **synthetic PII only** (fake emails/phones/names/SSNs/cards/IPs) — never real people
- Engine not installed → the run fails gracefully with: *"curation engine not installed — run `pip install -r services/api/requirements-curator.txt`"*

## UX States
- Form: a Switch (on by default), a checkbox group for entities, and a Select for redaction mode
- Detail: the `redacted` row shows the redaction action and span count in `detail`, or a "skipped" badge

## Verification
- Test files: `services/api/tests/` curation stage tests
- Required cases: emails/SSNs redacted under `replace`, PII disabled skips the stage, span-count best-effort fallback, entity subset honored
- Focused verify command: `pnpm test:api`
- Default pre-PR verify command: `pnpm verify`
- Full local verify command: `pnpm verify:full` when the E2E/live prerequisites in [Dev Workflows](../dev-workflows.md#commands) are available
- Pass criteria: focused tests and `pnpm verify` green; explain any skipped `pnpm verify:full` prerequisites

## Related Docs
- [Curation Runs](curation-runs.md), [Quality Filtering](quality-filtering.md)
- [Lineage & Versioned B2 Stages](lineage-and-b2-layout.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md), [SECURITY.md](../SECURITY.md)
