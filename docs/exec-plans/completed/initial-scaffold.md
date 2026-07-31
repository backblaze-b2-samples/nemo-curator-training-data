# Build plan — `nemo-curator-training-data`

Scaffolds a new B2 sample from the **vibe-coding-starter-kit** (source of truth:
`.claude/scratch/vcsk-29db4499-4642-4b94-915f-88d9ba4e2035/`). This plan is the
contract for the builder and reviewer.

---

## 1. Purpose

`nemo-curator-training-data` is a **training-data curation pipeline** for ML
platform engineers and data teams preparing pretraining / fine-tuning corpora.
It takes a raw text dump (web crawl, scraped docs — the demo ships a tiny
synthetic one, but the design targets multi-GB) and runs it through a
multi-stage NeMo Curator pipeline — **deduplicate → quality-filter → PII-redact**
— writing **each stage's output as its own versioned, sharded JSONL set to
Backblaze B2**. The run manifest tracks lineage and per-stage stats, so the
output is an audit-ready, lineage-tracked corpus that a downstream training job
pulls straight from B2.

The sample's B2 story is **write amplification on a data-heavy workload**: raw +
deduped + filtered + redacted = up to 4× copies of the corpus land in B2, all
via the **S3-compatible API** with a custom user-agent and standardized `B2_*`
env vars. No second API key — NeMo Curator is local OSS; B2 credentials only.

---

## 2. Architecture delta from vibe-coding-starter-kit

The starter kit is the **ceiling** — strip what this app doesn't need, keep the
reusable B2 scaffolding, add the curation surface.

### KEEP (as-is — starter contract, do not strip/rename/replace)
- **UI kit / design system**: `apps/web/src/components/ui/`, tokens in
  `apps/web/src/app/globals.css`, `/design` page. Build new screens from these.
- **File Explorer (`/files`)** — the full-bucket browser. **Non-negotiable keep.**
  This app's own scoped explorer is *added* (below), never a replacement.
- **Upload (`/upload`)** — reused to stage a raw corpus file (JSONL/text/`.txt`
  dump) into B2. The sidebar Upload + Files + Settings + Design entries stay.
- **Backend layering** (`types→config→repo→service→runtime`), structural tests,
  OpenAPI contract discipline, TanStack Query data layer, `/health`, `/metrics`,
  rate-limit + CORS middleware, JSON logging.
- **Settings page** — already a clearly-labeled demo; keep as-is.
- **Header branding** — this fresh clone already derives the title from
  `APP_NAME` + a `pageTitles` map + `deriveTitleFromPath` (no "oss-starter-kit"
  leak). Builder only adds the new routes to the `pageTitles` map.

### TRIM (remove / demote from the starter)
- **Dashboard defaults** (`apps/web/src/components/dashboard/`): replace the
  file-centric stat cards, upload-activity chart, and recent-uploads table with
  **corpus-curation metrics** (see §4). New aggregations flow through
  `runtime→service→repo` and TanStack Query hooks (AGENTS.md §2/§3).
- **Metadata-extraction as a headline feature**: KEEP the code path (upload
  metadata via Pillow/PyPDF2 is harmless and ripping it out risks contract-test
  churn), but **demote** it — drop it from the README headline feature list and
  note in its feature doc that it's an inherited starter capability, not a
  curation feature. Do NOT delete `service/metadata.py` or its routes/tests.

### ADD (new for `nemo-curator-training-data`)
- **Curation Runs** — the primary entity (§4). Full CRUD + run in the UI:
  `/runs` (list + create), `/runs/[id]` (detail/read + edit + delete + run).
- **Corpus Explorer (`/corpus`)** — the **sample-specific asset explorer scoped
  to the app's own B2 prefix** (`nemo-curator/`). Lists the sharded stage
  outputs grouped by run → stage, with per-shard size and a first-N-documents
  preview. This is the mandated scoped explorer that coexists with (never
  replaces) the full `/files` bucket explorer.
- **Backend curation surface** in `repo/`, `service/`, `runtime/`:
  - `repo/curator.py` — **lazy-imports NeMo Curator** (see §3 install note) and
    runs the dedup/filter/redact stages against local temp shards.
  - `repo/runs_store.py` — persists run manifests + stage shards to B2 (S3 API).
  - `service/runs.py` — orchestration: create/read/edit/delete/execute, lineage
    + per-stage stats bookkeeping.
  - `runtime/runs.py` — REST routes (§ API contract below).
- **Bundled synthetic demo corpus** (`services/api/app/data/demo-corpus.jsonl`,
  ~40 docs): contains intentional exact duplicates, low-quality docs (too
  short / high symbol ratio), and **synthetic-only** PII (fake emails, phones,
  names, US_SSN, credit-card, IP). **Never real people / real PII.** One-click
  "use demo corpus" source so a full demo needs no external data and no key.

> **Explorer tension note (required by the skill):** none. The full-bucket
> explorer is kept unchanged AND a scoped `/corpus` explorer is added. No
> conflict.

---

## 3. B2 surface (S3 operations)

All via the **S3-compatible API** (boto3), contained in `repo/`. **No b2-native
API.** Custom user-agent set on the single cached S3 client.

| Operation | Used by |
|-----------|---------|
| `put_object` | write stage shards (JSONL) + run `manifest.json` under `nemo-curator/runs/<id>/…` |
| `get_object` | read prior-stage shards to feed the next stage; document preview |
| `list_objects_v2` | list a run's shards (Corpus Explorer); dashboard aggregation; full `/files` browser (kept) |
| `head_object` | per-shard sizes / write-amplification totals |
| `delete_objects` | delete a run — **scoped strictly to `nemo-curator/runs/<id>/`** (never other prefixes; matches the shared-bucket safety rule) |
| presigned GET | download a shard from the Corpus Explorer |

**B2 layout (app prefix `nemo-curator/`):**
```
nemo-curator/runs/<run_id>/manifest.json
nemo-curator/runs/<run_id>/stages/raw/part-*.jsonl
nemo-curator/runs/<run_id>/stages/deduped/part-*.jsonl
nemo-curator/runs/<run_id>/stages/filtered/part-*.jsonl
nemo-curator/runs/<run_id>/stages/redacted/part-*.jsonl
```
B2 is the **sole data store** — run state lives in `manifest.json`, no DB (keeps
the starter's "no application database" invariant).

**b2-native use:** none. All S3. ✅ standard #1.

**NeMo Curator install note (justified deviation — read carefully):** NeMo
Curator's full dependency tree (dask, spacy+Presidio, fasttext, justext, …) is
heavy and slow-to-resolve on macOS arm64, and the starter's fast, reliable
`pnpm run setup` + credential-free `pnpm verify` contract must not depend on it.
So the engine is **split out of the default lock**:
- `services/api/requirements.txt` / `requirements.lock` → the **light API stack
  only** (fastapi, uvicorn, boto3, pydantic, Pillow, PyPDF2). `pnpm run setup`
  installs this; the app boots, serves the UI, `/health`, and all read routes,
  and **`pnpm verify` passes** without the curation engine present.
- `services/api/requirements-curator.txt` → the **NeMo Curator engine**, pinned
  (`nemo-curator`, `spacy`, `presidio-analyzer`, `presidio-anonymizer`, `dask`,
  and the `en_core_web_sm` spaCy model via its release wheel URL for a
  reproducible install). Installed on demand to actually run curations; the
  verify pipeline step installs it (a native linux/arm64 container is an
  acceptable path if macOS resolution fails).
- `repo/curator.py` **lazy-imports** `nemo_curator` *inside* the run function.
  If the engine isn't installed, `POST /runs/execute` fails the run with a clear
  `"curation engine not installed — pip install -r requirements-curator.txt"`
  message surfaced in the UI (graceful degradation, so screenshot/verify don't
  crash). This keeps NeMo Curator genuinely wired (vendor fidelity) while
  keeping the build/verify gate fast and green. **Pin every ML dep** — unpinned
  torch/transformers/etc. is a false-green that only e2e catches.

---

## 4. Key features

Each seeds a README bullet + a `docs/features/<feature>.md` stub.

1. **Curation runs** (`docs/features/curation-runs.md`) — create, configure,
   run, inspect, edit, and delete a multi-stage curation pipeline over a raw
   corpus. The primary entity.
2. **Deduplication** (`docs/features/deduplication.md`) — NeMo Curator **exact**
   dedup removes duplicate documents; deduped shards written to B2. (Fuzzy dedup
   is GPU-only via RAPIDS — offered as a labeled, disabled "requires CUDA GPU"
   option, not the default.)
3. **Quality filtering** (`docs/features/quality-filtering.md`) — NeMo Curator
   **heuristic** filters (word count, mean word length, symbol-to-word ratio,
   non-alpha ratio, repeated-line fraction) score and prune low-quality docs;
   filtered shards written as a separate versioned stage. CPU, no model
   download. (Classifier-based filtering noted as an optional GPU path.)
4. **PII redaction** (`docs/features/pii-redaction.md`) — NeMo Curator's
   Presidio-backed `PiiModifier` detects and redacts PII (EMAIL_ADDRESS,
   PHONE_NUMBER, PERSON, US_SSN, CREDIT_CARD, IP_ADDRESS) over filtered shards;
   clean output written to B2. Uses spaCy `en_core_web_sm` (CPU).
5. **Lineage & versioned B2 stages** (`docs/features/lineage-and-b2-layout.md`)
   — every stage is a separate versioned sharded set under the run's prefix; the
   manifest tracks lineage + per-stage docs-in/out + bytes written (the
   write-amplification story). *This is the feature that makes B2 the star.*
6. **Corpus Explorer** (`docs/features/corpus-explorer.md`) — browse a run's
   curated shards by stage, scoped to the app's B2 prefix, with document
   preview and download.

### External API provider
**None.** NeMo Curator is local OSS. Per-feature deployment field:

| Feature | Provider | Model | `deployment` | Est. cost / full demo run | Key env var |
|---------|----------|-------|--------------|---------------------------|-------------|
| Dedup / Quality / PII (the whole pipeline) | NeMo Curator (local OSS) | heuristics + spaCy `en_core_web_sm` (Presidio) | **local** | **$0** (no external calls; B2 storage only) | none |

- `deployment: local` → **CPU default, GPU autodetect**: at runtime pick the
  first available of **CUDA → CPU**. NeMo Curator runs on **Dask**; GPU means a
  RAPIDS `LocalCUDACluster` (dask-cuda), CPU means a plain `LocalCluster`.
  **No Apple MPS path** for Dask/RAPIDS — this sample's local heavy path is
  CUDA→CPU (note per the api-provider hard rule). Default demo runs CPU.
- **No Genblaze**: the description does not mention Genblaze / `genblaze-*` /
  `genblaze-s3`, and there is no external AI provider to route — so no Genblaze
  SDK. Straight boto3 in `repo/`.

### Primary-entity lifecycle — **Curation Run** (all verbs built; none omitted)

| Verb | UI | Notes |
|------|----|-------|
| **create** | `/runs` "New run" form → `POST /runs` | writes `manifest.json` (status `pending`) |
| **read** | `/runs/[id]` detail → `GET /runs/detail?run_id=` | config, status, per-stage docs-in/out + bytes, lineage, links to shards |
| **edit** | `/runs/[id]` edit dialog → `PATCH /runs?run_id=` | edits name + stage config; allowed while the run is **not currently executing** |
| **delete** | `/runs` + detail → `DELETE /runs?run_id=` | confirm dialog; deletes manifest + all stage shards, **scoped to the run's prefix** |
| **run** | `/runs/[id]` "Run pipeline" → `POST /runs/execute?run_id=` | executes stages in a background thread; UI polls `GET /runs/detail` for status/progress |

`omitted_ui_verbs`: **empty** — all five verbs are user-accessible.

### Form UX conventions
CREATE form (`/runs` new-run) — fields with a finite value set use a selector,
never free text; free-text only for the run **name**:
- **Source** — `Select`: `Demo corpus (bundled)` | `Uploaded B2 prefix`.
- **Stages** — three `Switch`es: Deduplicate / Quality filter / PII redact.
- **Dedup mode** — `Select`: `Exact` | `Exact + Fuzzy (requires CUDA GPU)`
  (fuzzy option disabled/labeled when no GPU).
- **Quality preset** — `Select`: `Lenient` | `Standard` | `Strict` (maps to
  threshold sets).
- **PII entities** — checkbox group (finite set: EMAIL_ADDRESS, PHONE_NUMBER,
  PERSON, US_SSN, CREDIT_CARD, IP_ADDRESS).
- **Redaction mode** — `Select`: `Replace with tag` | `Mask` | `Hash`.
- **Name** — free-text `Input`.

CREATE default hints (placeholder / `FormDescription` only — **no autofill
button**): Source = *Demo corpus*, all three stages on, Dedup = *Exact*,
Quality = *Standard*, PII = *[EMAIL, PHONE, PERSON, US_SSN]*, Redaction =
*Replace with tag* — a sound, cheap, keyless test run.

EDIT form — same selectors, opens **pre-filled** from the run's real config; no
default hints (it edits a real resource). Exemplar to match:
`apps/web/src/components/settings/settings-form.tsx` (does selector + hint
patterns already).

### Dashboard (adapted)
Stat cards: **Total runs**, **Documents processed**, **Documents removed**
(dedup + filter), **PII spans redacted**, **Total bytes written to B2** (write
amplification). Chart: per-stage **funnel** (docs raw → deduped → filtered →
redacted) or a write-amplification bar. Recent runs table (name, status, source,
docs-in→out, when). All via `GET /runs/stats` + TanStack Query hooks.

### API contract (new routes — re-export `docs/api/openapi.json`, update
`API_CLIENT_ROUTES`, `queries.ts`; backend-only routes go in
`SERVER_ONLY_OPERATIONS`)
- `GET  /runs` — list runs (reads manifests under app prefix)
- `POST /runs` — create run
- `GET  /runs/detail?run_id=` — run detail (query param; avoids `/runs/{id}`
  route-collision pattern, mirroring the starter's `files-by-key` design)
- `PATCH /runs?run_id=` — edit run config
- `DELETE /runs?run_id=` — delete run (scoped)
- `POST /runs/execute?run_id=` — start execution (background)
- `GET  /runs/shards?run_id=&stage=` — list a run/stage's shards (Corpus Explorer)
- `GET  /runs/document?run_id=&stage=&shard=&limit=` — preview first N docs
- `GET  /runs/stats` — dashboard aggregates

---

## 5. Doc transforms
- **Rewrite**: `docs/features/dashboard.md` (corpus metrics, not file stats);
  `README.md` (new purpose, feature list, quick start incl. the
  `requirements-curator.txt` step + spaCy model note); `ARCHITECTURE.md` (add
  the runs/curator/corpus components, the `nemo-curator/` B2 layout, the lazy
  NeMo Curator import + engine-split rationale); `docs/app-workflows.md`
  (create → run → inspect → download journey).
- **Add stubs**: `docs/features/{curation-runs, deduplication, quality-filtering,
  pii-redaction, lineage-and-b2-layout, corpus-explorer}.md`.
- **Demote (keep file, note inherited)**: `docs/features/metadata-extraction.md`.
- **Keep**: `docs/features/{file-upload,file-browser,settings}.md`,
  `docs/{SECURITY,RELIABILITY,dev-workflows,design-system}.md`.

---

## 6. Rename table

| From (`vibe-coding-starter-kit`) | To (`nemo-curator-training-data`) |
|---|---|
| kebab id `vibe-coding-starter-kit` | `nemo-curator-training-data` |
| npm scope `@vibe-coding-starter-kit/*` (`shared`, `web`) | `@nemo-curator-training-data/*` |
| Title Case "Vibe Coding Starter Kit" | "NeMo Curator Training Data" |
| snake `vibe_coding_starter_kit` (py modules/tags if any) | `nemo_curator_training_data` |
| `APP_NAME` = "OSS Starter Kit" | "NeMo Curator Training Data" |
| `APP_DESCRIPTION` | "Curate LLM training corpora with NeMo Curator, versioned on Backblaze B2" |
| S3 `user_agent_extra` = "b2ai-oss-start" | "nemo-curator-training-data" |
| UTM `utm_content=b2ai-oss-start` | `utm_content=b2ai-nemo-curator` |
| Railway service names / workflow slugs `vibe-coding-starter-kit` | `nemo-curator-training-data` |
| root `package.json` name, `pnpm-workspace` refs, lockfile scope refs | `nemo-curator-training-data` |

### B2 env-var standardization (parent CLAUDE.md standard #3 — mandatory)
The starter deviates; rename in `.env.example`, `settings.py`
(field names), `b2_client.py`, and all docs:

| Starter var | Standard var | Required? |
|---|---|---|
| `B2_KEY_ID` | `B2_APPLICATION_KEY_ID` | required |
| `B2_APPLICATION_KEY` | `B2_APPLICATION_KEY` (unchanged) | required |
| `B2_BUCKET_NAME` | `B2_BUCKET_NAME` (unchanged) | required |
| *(missing)* | `B2_REGION` (passed as boto3 `region_name`) | required |
| `B2_ENDPOINT` | `B2_ENDPOINT` (kept — boto3 `endpoint_url`; not in the standard-5 but required by B2/boto3) | required |
| `b2_public_url` | `B2_PUBLIC_URL_BASE` | **optional** (don't seed-env-BLOCK on it; mark optional / defaulted) |

Settings field renames: `b2_key_id→b2_application_key_id`,
add `b2_region`, `b2_public_url→b2_public_url_base`.

---

## Non-goals / guardrails
- No push to remote, no binary assets (screenshots/logos), no touching sibling
  samples — later pipeline steps own those.
- Synthetic PII only in the demo corpus. Never real people / real PII.
- Deletes always scoped to `nemo-curator/runs/<id>/` — never wipe shared bucket
  data used by other apps.
