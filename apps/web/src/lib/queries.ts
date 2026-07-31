"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createRun,
  deleteFile,
  deleteRun,
  executeRun,
  getDownloadUrl,
  getFileDetail,
  getFiles,
  getFileStats,
  getHealth,
  getPreviewUrl,
  getRunDetail,
  getRunDocument,
  getRuns,
  getRunShards,
  getRunStats,
  getUploadActivity,
  updateRun,
} from "@/lib/api-client";
import type {
  CreateRunRequest,
  FileMetadata,
  FileMetadataDetail,
  RunManifest,
  StageName,
  UpdateRunRequest,
} from "@nemo-curator-training-data/shared";

// Single source of truth for query keys. Keep these tightly scoped so that
// invalidating "files" doesn't blow away unrelated caches, and so an IDE
// "find usages" of `qk.files` reveals every consumer.
export const qk = {
  all: ["b2"] as const,
  files: (prefix?: string, limit?: number) =>
    [...qk.all, "files", prefix ?? "", limit ?? 100] as const,
  stats: () => [...qk.all, "stats"] as const,
  uploadActivity: (days: number) =>
    [...qk.all, "stats", "activity", days] as const,
  preview: (key: string) => [...qk.all, "preview", key] as const,
  detail: (key: string) => [...qk.all, "detail", key] as const,
  health: () => [...qk.all, "health"] as const,
  runs: () => [...qk.all, "runs"] as const,
  runStats: () => [...qk.all, "runs", "stats"] as const,
  runDetail: (runId: string) => [...qk.all, "runs", "detail", runId] as const,
  runShards: (runId: string, stage: string) =>
    [...qk.all, "runs", "shards", runId, stage] as const,
  runDocument: (runId: string, stage: string, shard: string, limit: number) =>
    [...qk.all, "runs", "document", runId, stage, shard, limit] as const,
};

export type Health = Awaited<ReturnType<typeof getHealth>>;

/**
 * Gate a query on something being open/visible. Deliberately the only option we
 * expose, so callers can't drift the caching policy per call site — the ⌘K
 * palette reuses `useFiles`' key (and therefore its cache) instead of fetching
 * its own private, smaller list.
 */
export interface QueryGate {
  enabled?: boolean;
}

export function useFiles(prefix = "", limit = 100, { enabled = true }: QueryGate = {}) {
  return useQuery<FileMetadata[], ApiError>({
    queryKey: qk.files(prefix, limit),
    queryFn: () => getFiles(prefix, limit),
    enabled,
  });
}

export function useFileStats({ enabled = true }: QueryGate = {}) {
  return useQuery({
    queryKey: qk.stats(),
    queryFn: getFileStats,
    enabled,
  });
}

export function useUploadActivity(days = 7) {
  return useQuery({
    queryKey: qk.uploadActivity(days),
    queryFn: () => getUploadActivity(days),
  });
}

// Presigned preview URL — only fetched when `enabled` is true (e.g., when
// the dialog opens for a specific file). Kept short-lived (60s) because
// the URL itself has a presigned expiry and is cheap to regenerate.
export function usePreviewUrl(key: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.preview(key ?? ""),
    queryFn: () => getPreviewUrl(key as string),
    enabled: enabled && !!key,
    staleTime: 60_000,
  });
}

// Rich metadata for an already-stored file. The server recomputes it on demand
// (a full object download), so it's only fetched when `enabled` — i.e. the
// preview dialog is open AND the user expands "Detailed metadata". Kept
// short-lived like the preview URL; cheap correctness under key overwrites.
export function useFileDetail(key: string | undefined, enabled: boolean) {
  return useQuery<FileMetadataDetail, ApiError>({
    queryKey: qk.detail(key ?? ""),
    queryFn: () => getFileDetail(key as string),
    enabled: enabled && !!key,
    staleTime: 60_000,
  });
}

// Health poll for the top-of-app B2 banner. `retry: false` and letting a
// failed fetch leave `data` undefined keeps a down API silent (the
// per-component ErrorState covers that); the banner only reacts to an up API
// reporting b2_connected: false. Polls every 60s and on window focus.
export function useHealth() {
  return useQuery<Health>({
    queryKey: qk.health(),
    queryFn: getHealth,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Drop a deleted object from every cached file list, plus its own cached
 * preview/detail entries.
 *
 * Invalidation alone is not enough: the refetch re-lists the whole bucket and
 * took 5-6s in practice, so the success toast fired while the row was still
 * listed — and using that stale row's Preview 404'd. Editing the cache makes
 * the row disappear with the toast; the invalidation that follows still
 * reconciles against the server.
 *
 * Exported for tests — the mutation below is its only production caller.
 */
export function dropDeletedFileFromCache(qc: QueryClient, fileKey: string) {
  qc.setQueriesData<FileMetadata[]>(
    // Partial key: matches qk.files(prefix, limit) for every prefix/limit.
    { queryKey: [...qk.all, "files"] },
    (previous) =>
      previous ? previous.filter((file) => file.key !== fileKey) : previous,
  );
  // A presigned URL for a deleted key can only 404 now.
  qc.removeQueries({ queryKey: qk.preview(fileKey) });
  qc.removeQueries({ queryKey: qk.detail(fileKey) });
}

/**
 * Fetch a download URL for one file.
 *
 * A mutation, not a query: it has a server side effect (it bumps the download
 * counter) and it must never be cached or replayed. Being a mutation is also
 * what gives the UI an honest pending state — the old code awaited the presign
 * inside a plain click handler, so a slow round trip left the screen completely
 * unchanged and a user could not tell a working download from a dead button.
 *
 * The caller performs the navigation (see `lib/browser-download.ts`) and gets
 * `isPending` / `variables` for the pending row.
 */
export function useDownloadUrl() {
  const qc = useQueryClient();
  return useMutation<{ url: string }, ApiError, FileMetadata>({
    mutationFn: (file) => getDownloadUrl(file.key),
    // The server counted a download, so the dashboard's "Total Downloads" is
    // now stale. Cheap: /files/stats reads a cached bucket listing.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.stats() }),
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileKey: string) => deleteFile(fileKey),
    onSuccess: (_data, fileKey) => {
      // Remove the row immediately, then reconcile everything (lists, stats,
      // activity) against the server in the background.
      dropDeletedFileFromCache(qc, fileKey);
      qc.invalidateQueries({ queryKey: qk.all });
    },
  });
}

// --- Curation runs ---------------------------------------------------------
export function useRuns({ enabled = true }: QueryGate = {}) {
  return useQuery({
    queryKey: qk.runs(),
    queryFn: getRuns,
    enabled,
  });
}

export function useRunStats({ enabled = true }: QueryGate = {}) {
  return useQuery({
    queryKey: qk.runStats(),
    queryFn: getRunStats,
    enabled,
  });
}

/**
 * Run detail with self-adjusting polling: while a run is executing the manifest
 * changes as each stage lands in B2, so poll every 1.5s; once it settles
 * (completed/failed/pending) stop polling and rely on cache + mutations.
 */
export function useRunDetail(runId: string | undefined, { enabled = true }: QueryGate = {}) {
  return useQuery<RunManifest, ApiError>({
    queryKey: qk.runDetail(runId ?? ""),
    queryFn: () => getRunDetail(runId as string),
    enabled: enabled && !!runId,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1500 : false,
  });
}

export function useRunShards(
  runId: string,
  stage: StageName,
  { enabled = true }: QueryGate = {}
) {
  return useQuery({
    queryKey: qk.runShards(runId, stage),
    queryFn: () => getRunShards(runId, stage),
    enabled,
  });
}

export function useRunDocument(
  runId: string,
  stage: StageName,
  shard: string | undefined,
  limit = 20,
  { enabled = true }: QueryGate = {}
) {
  return useQuery({
    queryKey: qk.runDocument(runId, stage, shard ?? "", limit),
    queryFn: () => getRunDocument(runId, stage, shard as string, limit),
    enabled: enabled && !!shard,
    staleTime: 60_000,
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRunRequest) => createRun(req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.runs() });
      qc.invalidateQueries({ queryKey: qk.runStats() });
    },
  });
}

export function useUpdateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, req }: { runId: string; req: UpdateRunRequest }) =>
      updateRun(runId, req),
    onSuccess: (_data, { runId }) => {
      qc.invalidateQueries({ queryKey: qk.runDetail(runId) });
      qc.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}

export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => deleteRun(runId),
    onSuccess: (_data, runId) => {
      qc.removeQueries({ queryKey: qk.runDetail(runId) });
      qc.invalidateQueries({ queryKey: qk.runs() });
      qc.invalidateQueries({ queryKey: qk.runStats() });
    },
  });
}

export function useExecuteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => executeRun(runId),
    onSuccess: (data) => {
      // Seed the detail cache with the "running" manifest so the detail view
      // starts polling immediately, then reconcile the list.
      qc.setQueryData(qk.runDetail(data.run_id), data);
      qc.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}
