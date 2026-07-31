// Shared option sets + labels for curation runs. Single source of truth for the
// create/edit form selectors, the run tables, and the detail view so they never
// drift. Mirrors the finite option types in
// `@nemo-curator-training-data/shared` (and services/api/app/types/runs.py).
import type {
  DedupMode,
  PiiEntity,
  QualityPreset,
  RedactionMode,
  RunConfig,
  RunSource,
  RunStatus,
  StageName,
} from "@nemo-curator-training-data/shared";

export const SOURCE_OPTIONS: { value: RunSource; label: string }[] = [
  { value: "demo", label: "Demo corpus (bundled)" },
  { value: "b2_prefix", label: "Uploaded B2 prefix" },
];

// Fuzzy dedup is GPU-only (RAPIDS/dask-cuda), so the option is present but
// disabled and labeled — the default demo runs exact dedup on CPU.
export const DEDUP_MODE_OPTIONS: {
  value: DedupMode;
  label: string;
  disabled?: boolean;
}[] = [
  { value: "exact", label: "Exact" },
  { value: "exact_fuzzy", label: "Exact + Fuzzy (requires CUDA GPU)", disabled: true },
];

export const QUALITY_PRESET_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: "lenient", label: "Lenient" },
  { value: "standard", label: "Standard" },
  { value: "strict", label: "Strict" },
];

export const REDACTION_MODE_OPTIONS: { value: RedactionMode; label: string }[] = [
  { value: "replace", label: "Replace with tag" },
  { value: "mask", label: "Mask" },
  { value: "hash", label: "Hash" },
];

export const PII_ENTITY_OPTIONS: { value: PiiEntity; label: string }[] = [
  { value: "EMAIL_ADDRESS", label: "Email address" },
  { value: "PHONE_NUMBER", label: "Phone number" },
  { value: "PERSON", label: "Person name" },
  { value: "US_SSN", label: "US SSN" },
  { value: "CREDIT_CARD", label: "Credit card" },
  { value: "IP_ADDRESS", label: "IP address" },
];

// Safe, cheap, keyless defaults. Surfaced to the create form as pre-selected
// values + hint copy (never an autofill button).
export const DEFAULT_RUN_CONFIG: RunConfig = {
  source: "demo",
  source_prefix: null,
  dedup_enabled: true,
  quality_enabled: true,
  pii_enabled: true,
  dedup_mode: "exact",
  quality_preset: "standard",
  pii_entities: ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON", "US_SSN"],
  redaction_mode: "replace",
};

export const STAGE_ORDER: StageName[] = ["raw", "deduped", "filtered", "redacted"];

export const STAGE_LABELS: Record<StageName, string> = {
  raw: "Raw",
  deduped: "Deduplicated",
  filtered: "Quality-filtered",
  redacted: "PII-redacted",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const STATUS_META: Record<
  RunStatus,
  { label: string; variant: BadgeVariant }
> = {
  pending: { label: "Pending", variant: "outline" },
  running: { label: "Running", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
};

export function labelFor(
  options: { value: string; label: string }[],
  value: string,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}
