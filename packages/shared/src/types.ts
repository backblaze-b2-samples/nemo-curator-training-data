export type FileStatus = "uploading" | "complete" | "error";

export interface FileMetadata {
  key: string;
  filename: string;
  folder: string;
  size_bytes: number;
  size_human: string;
  content_type: string;
  uploaded_at: string;
  url: string | null;
}

export interface FileMetadataDetail {
  filename: string;
  size_bytes: number;
  size_human: string;
  mime_type: string;
  extension: string;
  md5: string;
  sha256: string;
  uploaded_at: string;
  /** Set when a format-specific extractor was skipped or failed (e.g. an image
   *  above the decompression-bomb decode limit). Core fields stay exact. */
  metadata_warning: string | null;
  // Image-specific
  image_width: number | null;
  image_height: number | null;
  exif: Record<string, string> | null;
  // PDF-specific
  pdf_pages: number | null;
  pdf_author: string | null;
  pdf_title: string | null;
  // Audio/Video
  duration_seconds: number | null;
  codec: string | null;
  bitrate: number | null;
}

export interface FileUploadResponse {
  key: string;
  filename: string;
  size_bytes: number;
  size_human: string;
  content_type: string;
  uploaded_at: string;
  url: string | null;
  metadata: FileMetadataDetail | null;
}

export interface DailyUploadCount {
  date: string;
  uploads: number;
}

export interface UploadStats {
  total_files: number;
  total_size_bytes: number;
  total_size_human: string;
  uploads_today: number;
  total_downloads: number;
}

// --- Curation runs (primary entity) ----------------------------------------
// Mirrors services/api/app/types/runs.py. Kept in sync by hand (see the API
// contract test); the finite option sets match the create/edit form selectors.
export type RunSource = "demo" | "b2_prefix";
export type DedupMode = "exact" | "exact_fuzzy";
export type QualityPreset = "lenient" | "standard" | "strict";
export type RedactionMode = "replace" | "mask" | "hash";
export type PiiEntity =
  | "EMAIL_ADDRESS"
  | "PHONE_NUMBER"
  | "PERSON"
  | "US_SSN"
  | "CREDIT_CARD"
  | "IP_ADDRESS";
export type StageName = "raw" | "deduped" | "filtered" | "redacted";
export type RunStatus = "pending" | "running" | "completed" | "failed";
export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export interface RunConfig {
  source: RunSource;
  source_prefix: string | null;
  dedup_enabled: boolean;
  quality_enabled: boolean;
  pii_enabled: boolean;
  dedup_mode: DedupMode;
  quality_preset: QualityPreset;
  pii_entities: PiiEntity[];
  redaction_mode: RedactionMode;
}

export interface StageResult {
  stage: StageName;
  status: StageStatus;
  docs_in: number;
  docs_out: number;
  docs_removed: number;
  pii_spans_redacted: number;
  bytes_written: number;
  shard_count: number;
  detail: string | null;
}

export interface RunManifest {
  run_id: string;
  name: string;
  config: RunConfig;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  error: string | null;
  source_docs: number;
  total_bytes_written: number;
  stages: StageResult[];
}

export interface RunSummary {
  run_id: string;
  name: string;
  status: RunStatus;
  source: RunSource;
  created_at: string;
  updated_at: string;
  source_docs: number;
  final_docs: number;
  total_bytes_written: number;
  total_bytes_human: string;
  error: string | null;
}

export interface ShardInfo {
  key: string;
  filename: string;
  size_bytes: number;
  size_human: string;
}

export interface ShardList {
  run_id: string;
  stage: StageName;
  shards: ShardInfo[];
}

export interface DocumentPreview {
  run_id: string;
  stage: StageName;
  shard: string;
  documents: Record<string, unknown>[];
  returned: number;
  truncated: boolean;
}

export interface ShardDownload {
  url: string;
}

export interface FunnelPoint {
  stage: StageName;
  label: string;
  documents: number;
}

export interface RunStats {
  total_runs: number;
  documents_processed: number;
  documents_removed: number;
  pii_spans_redacted: number;
  total_bytes_written: number;
  total_bytes_human: string;
  funnel: FunnelPoint[];
  recent: RunSummary[];
}

export interface CreateRunRequest {
  name: string;
  config: RunConfig;
}

export interface UpdateRunRequest {
  name?: string | null;
  config?: RunConfig | null;
}
