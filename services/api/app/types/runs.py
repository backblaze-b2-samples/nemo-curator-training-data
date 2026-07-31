"""Pydantic models for the curation-run surface.

A *curation run* is the primary entity of this app: a multi-stage NeMo Curator
pipeline (deduplicate -> quality-filter -> PII-redact) over a raw corpus, whose
per-stage sharded outputs and lineage manifest live in Backblaze B2. These
models are the boundary contract for every /runs route and mirror
`packages/shared/src/types.ts`.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# --- Finite option sets (mirrored by the frontend form selectors) ------------
SourceType = Literal["demo", "b2_prefix"]
DedupMode = Literal["exact", "exact_fuzzy"]
QualityPreset = Literal["lenient", "standard", "strict"]
RedactionMode = Literal["replace", "mask", "hash"]
PiiEntity = Literal[
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "PERSON",
    "US_SSN",
    "CREDIT_CARD",
    "IP_ADDRESS",
]
StageName = Literal["raw", "deduped", "filtered", "redacted"]
RunStatus = Literal["pending", "running", "completed", "failed"]
StageStatus = Literal["pending", "running", "completed", "skipped", "failed"]

# Sound, cheap, keyless defaults surfaced to the user as form hints (never
# autofilled). A demo corpus, all three stages on, exact dedup, standard
# quality, the four highest-signal PII entities, replace-with-tag redaction.
DEFAULT_PII_ENTITIES: list[PiiEntity] = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "PERSON",
    "US_SSN",
]


class RunConfig(BaseModel):
    """Everything that shapes a run's stages. Edited via the create/edit forms."""

    source: SourceType = "demo"
    # Only used when source == "b2_prefix": the B2 key prefix holding raw
    # JSONL/text objects to curate (e.g. an /upload'ed dump).
    source_prefix: str | None = None

    dedup_enabled: bool = True
    quality_enabled: bool = True
    pii_enabled: bool = True

    dedup_mode: DedupMode = "exact"
    quality_preset: QualityPreset = "standard"
    pii_entities: list[PiiEntity] = Field(default_factory=lambda: list(DEFAULT_PII_ENTITIES))
    redaction_mode: RedactionMode = "replace"


class StageResult(BaseModel):
    """Per-stage lineage + stats. Written into the run manifest as each stage
    completes so the UI can poll progress."""

    stage: StageName
    status: StageStatus = "pending"
    docs_in: int = 0
    docs_out: int = 0
    docs_removed: int = 0
    pii_spans_redacted: int = 0
    bytes_written: int = 0
    shard_count: int = 0
    detail: str | None = None


class RunManifest(BaseModel):
    """The single source of truth for a run — persisted as manifest.json in B2.

    There is no application database (B2 is the sole store), so this document
    carries config, status, lineage, and the write-amplification totals.
    """

    run_id: str
    name: str
    config: RunConfig
    status: RunStatus = "pending"
    created_at: datetime
    updated_at: datetime
    error: str | None = None
    source_docs: int = 0
    total_bytes_written: int = 0
    stages: list[StageResult] = Field(default_factory=list)


class CreateRunRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    config: RunConfig = Field(default_factory=RunConfig)


class UpdateRunRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    config: RunConfig | None = None


class RunSummary(BaseModel):
    """Compact row for the /runs list and dashboard recent-runs table."""

    run_id: str
    name: str
    status: RunStatus
    source: SourceType
    created_at: datetime
    updated_at: datetime
    source_docs: int
    final_docs: int
    total_bytes_written: int
    total_bytes_human: str
    error: str | None = None


class ShardInfo(BaseModel):
    key: str
    filename: str
    size_bytes: int
    size_human: str


class ShardList(BaseModel):
    run_id: str
    stage: StageName
    shards: list[ShardInfo]


class DocumentPreview(BaseModel):
    run_id: str
    stage: StageName
    shard: str
    documents: list[dict] = Field(default_factory=list)
    returned: int = 0
    truncated: bool = False


class ShardDownload(BaseModel):
    url: str


class FunnelPoint(BaseModel):
    stage: StageName
    label: str
    documents: int


class RunStats(BaseModel):
    total_runs: int
    documents_processed: int
    documents_removed: int
    pii_spans_redacted: int
    total_bytes_written: int
    total_bytes_human: str
    funnel: list[FunnelPoint] = Field(default_factory=list)
    recent: list[RunSummary] = Field(default_factory=list)
