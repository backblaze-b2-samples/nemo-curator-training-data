<!-- last_verified: 2026-07-28 -->
# Architecture

## Components

- **apps/web/** — Next.js 16 frontend (App Router, Tailwind v4, shadcn/ui)
  - Curation Runs (`/runs`, `/runs/[id]`) — create, run, inspect, edit, delete the primary entity
  - Corpus Explorer (`/corpus`) — browse a run's stage shards scoped to the app's B2 prefix
  - Dashboard with curation metrics (runs, docs processed/removed, PII spans, bytes written) + per-stage funnel + recent runs
  - File upload with drag-and-drop, progress tracking (inherited starter surface; stages a raw corpus into B2)
  - File browser with preview, download, delete (inherited starter surface)
  - Dark mode via `next-themes`
- **services/api/** — FastAPI backend (layered architecture)
  - REST API for curation runs (`/runs*`), plus inherited file upload / listing / deletion
  - Multi-stage NeMo Curator pipeline: exact dedup → heuristic quality filter → Presidio PII redaction
  - B2 S3 integration via boto3 (the sole data store — manifests + stage shards)
  - File metadata extraction (images, PDFs) — inherited starter capability
  - Health check endpoint with B2 connectivity verification
  - Structured JSON logging with request tracing
  - Prometheus-format metrics endpoint
- **packages/shared/** — TypeScript type definitions
  - Mirrors Pydantic models from the API (including the curation-run models)
  - Consumed by `apps/web/` as workspace dependency

### Curation surface (added on top of the starter)

The curation run is the app's primary entity. It threads through every backend layer:

- `types/runs.py` — `RunConfig`, `RunManifest`, `StageResult`, `RunSummary`, `RunStats`, and the finite option `Literal`s (source, dedup mode, quality preset, redaction mode, PII entities, stage names) mirrored by the frontend form selectors.
- `runtime/runs.py` — thin REST handlers for `/runs*` (list, create, detail, edit, delete, execute, shards, document, shard-download, stats). No business logic.
- `service/runs.py` — the public facade: create/read/edit/delete/execute orchestration, lineage + per-stage stats bookkeeping, and the dashboard aggregation (`get_run_stats`).
- `service/run_engine.py` — engine internals kept under the 300-line ceiling: run exceptions, manifest load/save, source loading (bundled demo corpus or an uploaded B2 prefix), shard writing, and the background `run_pipeline` thread that streams each stage's output to B2 while the UI polls.
- `repo/curator.py` — the NeMo Curator engine adapter (external SDK, confined to `repo/`, **lazy-imported** — see below).
- `repo/runs_store.py` — B2 (S3) persistence for manifests and stage shards, reusing the cached custom-user-agent client from `repo/b2_client.py`.

## Backend Layering

The API follows a strict layered architecture:

```
types/     Pydantic models — no logic, no imports from other layers
  |
config/    Settings (pydantic-settings) — depends only on types
  |
repo/      Data access (boto3 B2 client) — no business logic
  |
service/   Business logic — calls repo, returns types
  |
runtime/   FastAPI routes — calls service, never repo directly
```

### Layering Rules

1. Dependencies flow downward only: `types` -> `config` -> `repo` -> `service` -> `runtime`
2. No backward imports (e.g., service must not import from runtime)
3. `boto3` only allowed in `repo/` layer
4. All boundary data uses Pydantic models (no raw dicts across layers)
5. Each file stays under 300 lines

### Directory Structure

```
services/api/
  main.py                  App entrypoint, middleware, router registration
  requirements.lock        Light API stack installed by `pnpm run setup`
  requirements-curator.txt  Heavy NeMo Curator engine, installed on demand
  app/
    data/                  Bundled synthetic demo corpus (demo-corpus.jsonl)
    types/                 Pydantic models (runs.py, files.py, stats.py, ...)
    config/                Settings loaded from environment
    repo/                  B2 S3 client + runs_store + curator (data access layer)
    service/               Business logic (runs, run_engine, upload, files, metadata)
    runtime/               FastAPI route handlers (runs.py, files.py, upload.py, ...)
  tests/                   pytest tests (structural + integration)
```

## Boundary Invariants

- **No external SDK leakage**: `boto3` is only imported in `app/repo/`. All other layers interact with B2 through the repo interface.
- **No raw dicts at boundaries**: All data crossing layer boundaries uses typed Pydantic models.
- **No cross-layer mutable state**: Configuration is read-only after init, and no mutable state is shared *between* layers. Intra-layer caches/counters (the listing cache in `repo/list_cache.py`, the B2 connectivity cache in `repo/b2_client.py`, the download counter in `repo/counter.py`, the rate-limit and metrics state in `runtime/`) are module-local and guarded by a `threading.Lock`. The listing cache also owns the only background thread in the app: a stale entry is served immediately while that thread re-scans (stale-while-revalidate), and `main.lifespan` warms it once at startup so no user pays for the cold full-bucket scan.
- **Validated inputs**: All HTTP inputs validated by FastAPI/Pydantic. File keys reject empty and path-traversal patterns; optional prefix confinement via `ALLOWED_KEY_PREFIX` (off by default).

## Curation Engine (NeMo Curator) — lazy import & engine split

The genuine curation engine is NVIDIA **NeMo Curator**, wrapped in
`repo/curator.py`. Nothing is simulated: dedup, quality filtering, and PII
redaction run NeMo Curator's own modules (`ExactDuplicates`, the heuristic
`ScoreFilter`s, and the Presidio-backed `PiiModifier`). If the engine is absent
a run fails loudly rather than producing fake output.

**Engine split.** NeMo Curator's dependency tree (Dask, spaCy + Presidio,
fasttext, justext, torch, …) is heavy and slow to resolve on macOS arm64, so it
is deliberately kept **out** of the default `requirements.lock`:

- `services/api/requirements.lock` — the light API stack (FastAPI, uvicorn,
  boto3, Pydantic, Pillow, PyPDF2). `pnpm run setup` installs this; the app
  boots, serves the UI, exports its OpenAPI contract, runs structural tests, and
  serves every read route with only this stack. **`pnpm verify` passes without
  the curation engine.**
- `services/api/requirements-curator.txt` — the pinned NeMo Curator engine
  (`nemo-curator`, `dask`, `spacy`, `presidio-analyzer`/`-anonymizer`, `torch`,
  and the `en_core_web_sm` model via a reproducible release-wheel URL). Installed
  on demand to actually run curations.

Every `nemo_curator` import lives **inside** `run_stages` in `repo/curator.py`,
never at module top. So without the engine installed, only `POST /runs/execute`
fails — the run is marked `failed` with a clear message
(`CuratorEngineNotInstalled`: *"curation engine not installed — run `pip install
-r services/api/requirements-curator.txt`"*) that the polling UI surfaces. This
keeps NeMo Curator genuinely wired while keeping the build/verify gate fast.

**Device selection** (`deployment: local`) is CUDA → CPU autodetect
(`select_backend`): GPU is chosen only when both a CUDA device and `dask-cuda`
are present (a RAPIDS `LocalCUDACluster` with a cuDF backend); otherwise a plain
Dask `LocalCluster` on pandas. There is no Apple MPS path for Dask/RAPIDS, so the
heavy local path is CUDA → CPU and the demo defaults to CPU.

## Deployment

- **Local dev** — `pnpm dev` runs both services via `concurrently`
  - Web: `localhost:3000`
  - API: `localhost:8000`
- **Railway** — two services from the same repository: `web` builds from the
  repository root because it consumes `packages/shared`; `api` builds from
  `services/api`. The versioned per-service configs and the human-approved
  staging/production contract live in [infra/railway/README.md](infra/railway/README.md).
  External provisioning and deployment remain explicit user-approved actions.

## Data Stores

- **Backblaze B2** — object storage (S3-compatible API)
  - All uploaded files and all curation output stored in a single bucket
  - File listing and metadata via S3 `list_objects_v2` / `head_object`
  - No application database — B2 is the sole data store; run state lives in each run's `manifest.json`

### B2 layout for curation runs

All curation state lives under the app prefix (`settings.app_prefix`, default
`nemo-curator/`). The full-bucket `/files` explorer is unaffected; deletes are
scoped strictly to a single run's prefix.

```
nemo-curator/runs/<run_id>/manifest.json
nemo-curator/runs/<run_id>/stages/raw/part-00000.jsonl
nemo-curator/runs/<run_id>/stages/deduped/part-*.jsonl
nemo-curator/runs/<run_id>/stages/filtered/part-*.jsonl
nemo-curator/runs/<run_id>/stages/redacted/part-*.jsonl
```

Each stage is its own versioned, sharded set (`SHARD_SIZE = 25` docs per shard).
`raw + deduped + filtered + redacted` means up to 4× copies of the corpus land
in B2 — the write-amplification story the manifest's `total_bytes_written`
tracks. B2 keys are computed in `repo/runs_store.py` (`manifest_key`,
`stage_prefix`, `shard_key`).

## External Services

- **Backblaze B2 S3 API** — file storage, retrieval, deletion, presigned URLs; the sole data store for uploads, run manifests, and stage shards
- **NeMo Curator** — local OSS curation engine (no network calls, no second API key); installed on demand, lazy-imported in `repo/curator.py`

## Trust Boundaries

See [docs/SECURITY.md](docs/SECURITY.md) for full security documentation.

- **Frontend -> API** — CORS-restricted to configured origins. `CORSMiddleware` is registered LAST in `main.py` (outermost) so it wraps **every** response, including uncaught-exception 500s — otherwise the browser would block error responses and the UI would only see an opaque "network error". See [docs/RELIABILITY.md](docs/RELIABILITY.md#error-handling). A per-IP rate-limit middleware sits inner to CORS; see [docs/SECURITY.md](docs/SECURITY.md#rate-limiting).
- **API -> B2** — authenticated via application keys, signature v4
- **Client -> B2** — presigned URLs for download (10-min expiry, forced attachment)

## Data Flows

- **Create run**: Browser -> `POST /runs` -> `service.runs.create_run` -> `runs_store.put_manifest` writes `manifest.json` (status `pending`)
- **Execute run**: Browser -> `POST /runs/execute?run_id=` -> `service.run_engine.run_pipeline` (background thread) -> loads source (demo corpus or a B2 prefix) -> `repo.curator.run_stages` runs each NeMo Curator stage -> `runs_store.put_shard` streams each stage's JSONL to B2 and re-saves the manifest per stage -> UI polls `GET /runs/detail`
- **Inspect / explore**: Browser -> `GET /runs/detail` (manifest + lineage) and `GET /runs/shards` / `GET /runs/document` (Corpus Explorer preview) -> `runs_store.list_shards` / `get_object_text`
- **Download shard**: Browser -> `GET /runs/shard-download` -> `runs_store.presign_shard` -> presigned GET (attachment)
- **Delete run**: Browser -> `DELETE /runs?run_id=` -> `runs_store.delete_run` deletes manifest + all stage shards, scoped strictly to the run's prefix
- **Dashboard**: Browser -> `GET /runs/stats` -> `service.runs.get_run_stats` aggregates every manifest
- **Upload** (inherited): Browser -> `POST /upload` (multipart) -> API validates -> service orchestrates -> repo writes to B2 -> metadata extracted -> response
- **List / Download / Delete files** (inherited): the full-bucket `/files` browser via `service.files` + `repo.b2_client`

## Observability

- Structured JSON logging on all requests with `request_id`
- Request timing middleware (logs duration per request; also the catch-all that converts uncaught exceptions to a typed JSON 500)
- `/metrics` endpoint (Prometheus format: request count, latency, upload count)
- `/health` endpoint (B2 connectivity check)

## API Contract

- Checked-in OpenAPI artifact: `docs/api/openapi.json`
- Export/check command: `pnpm contract:export` / `pnpm contract:check`
- FastAPI freshness test: `services/api/tests/test_openapi_contract.py`
- Frontend route drift test: `apps/web/src/lib/api-contract.test.ts`

The frontend client keeps a small `API_CLIENT_ROUTES` registry in
`apps/web/src/lib/api-client.ts`. Tests compare that registry to the checked-in
OpenAPI artifact so route changes fail loudly before the hand-written client can
silently drift from FastAPI. `GET /metrics` is intentionally server-only.

## Canonical Files

- Curation run routes: `services/api/app/runtime/runs.py`
- Curation orchestration: `services/api/app/service/runs.py` (+ `service/run_engine.py`)
- NeMo Curator engine adapter (lazy import): `services/api/app/repo/curator.py`
- Run persistence on B2: `services/api/app/repo/runs_store.py`
- Layered API handler: `services/api/app/runtime/upload.py`
- Service orchestration: `services/api/app/service/upload.py`
- B2 data access (repo layer): `services/api/app/repo/b2_client.py`
- Pydantic models: `services/api/app/types/` (`runs.py`, `files.py`, `upload.py`, `stats.py`, `formatting.py`)
- Config (pydantic-settings): `services/api/app/config/settings.py`
- Structural tests: `services/api/tests/test_structure.py`
- OpenAPI contract: `docs/api/openapi.json`
- OpenAPI exporter: `services/api/scripts/export_openapi.py`
- Frontend API client: `apps/web/src/lib/api-client.ts`
- Shared TypeScript types: `packages/shared/src/types.ts`

## Core Features

- [Curation Runs](docs/features/curation-runs.md)
- [Deduplication](docs/features/deduplication.md)
- [Quality Filtering](docs/features/quality-filtering.md)
- [PII Redaction](docs/features/pii-redaction.md)
- [Lineage & Versioned B2 Stages](docs/features/lineage-and-b2-layout.md)
- [Corpus Explorer](docs/features/corpus-explorer.md)
- [Dashboard](docs/features/dashboard.md)
- [File Upload](docs/features/file-upload.md) (inherited starter surface)
- [File Browser](docs/features/file-browser.md) (inherited starter surface)
- [Metadata Extraction](docs/features/metadata-extraction.md) (inherited starter capability)

## References

- [docs/SECURITY.md](docs/SECURITY.md) — security principles and implementation
- [docs/RELIABILITY.md](docs/RELIABILITY.md) — reliability expectations
- [AGENTS.md](AGENTS.md) — architectural invariants and agent instructions
