"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, FolderOpen, Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErrorState } from "@/components/ui/error-state";
import { RunStatusBadge } from "@/components/runs/run-status-badge";
import { RunEditDialog } from "@/components/runs/run-edit-dialog";
import { RunDeleteButton } from "@/components/runs/run-delete-button";
import { useExecuteRun, useRunDetail } from "@/lib/queries";
import {
  DEDUP_MODE_OPTIONS,
  QUALITY_PRESET_OPTIONS,
  REDACTION_MODE_OPTIONS,
  SOURCE_OPTIONS,
  STAGE_LABELS,
  STAGE_ORDER,
  labelFor,
} from "@/lib/run-options";
import type { ApiError } from "@/lib/api-client";
import { formatDate, humanizeBytes } from "@/lib/utils";

const STAGE_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  completed: "default",
  running: "secondary",
  skipped: "outline",
  pending: "outline",
  failed: "destructive",
};

export function RunDetail({ runId }: { runId: string }) {
  const router = useRouter();
  const { data: run, isLoading, error, refetch } = useRunDetail(runId);
  const executeRun = useExecuteRun();

  if (error) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }
  if (isLoading || !run) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const running = run.status === "running";
  const config = run.config;

  return (
    <div className="space-y-8">
      <div className="animate-fade-in flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="page-title truncate">{run.name}</h1>
            <RunStatusBadge status={run.status} />
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {run.status === "pending" ? (
              <>
                Created {formatDate(run.created_at)} · Not run yet — click Run
                pipeline to start
              </>
            ) : (
              <>
                Created {formatDate(run.created_at)} · {run.source_docs} source
                documents · {humanizeBytes(run.total_bytes_written)} written to
                B2
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            className="h-8"
            disabled={running || executeRun.isPending}
            onClick={() =>
              executeRun.mutate(run.run_id, {
                onSuccess: () => toast.success("Run started"),
                onError: (e) =>
                  toast.error("Could not start run", {
                    description: (e as ApiError).message,
                  }),
              })
            }
          >
            <Play className="h-3.5 w-3.5" />
            {running ? "Running..." : "Run pipeline"}
          </Button>
          <RunEditDialog run={run} disabled={running} />
          <RunDeleteButton
            runId={run.run_id}
            runName={run.name}
            disabled={running}
            onDeleted={() => router.push("/runs")}
          />
        </div>
      </div>

      {run.status === "failed" && run.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b border-border py-4 px-5">
          <CardTitle className="card-title">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Source" value={labelFor(SOURCE_OPTIONS, config.source)} />
          <Field
            label="Deduplicate"
            value={
              config.dedup_enabled
                ? labelFor(DEDUP_MODE_OPTIONS, config.dedup_mode)
                : "Off"
            }
          />
          <Field
            label="Quality filter"
            value={
              config.quality_enabled
                ? labelFor(QUALITY_PRESET_OPTIONS, config.quality_preset)
                : "Off"
            }
          />
          <Field
            label="PII redaction"
            value={
              config.pii_enabled
                ? labelFor(REDACTION_MODE_OPTIONS, config.redaction_mode)
                : "Off"
            }
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              PII entities
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {config.pii_enabled && config.pii_entities.length > 0 ? (
                config.pii_entities.map((e) => (
                  <Badge key={e} variant="outline">
                    {e}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">None</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b border-border py-4 px-5">
          <CardTitle className="card-title">Stage lineage</CardTitle>
          <Link
            href={`/corpus?run=${run.run_id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Browse shards
          </Link>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
          {STAGE_ORDER.map((stageName) => {
            const stage = run.stages.find((s) => s.stage === stageName);
            const status = stage?.status ?? "pending";
            return (
              <div
                key={stageName}
                className="rounded-md border border-border p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{STAGE_LABELS[stageName]}</span>
                  <Badge variant={STAGE_STATUS_VARIANT[status]}>
                    {status === "running" && (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    )}
                    {status}
                  </Badge>
                </div>
                <dl className="space-y-1 text-xs text-muted-foreground tabular-nums">
                  <Row k="Docs in" v={stage?.docs_in ?? 0} />
                  <Row k="Docs out" v={stage?.docs_out ?? 0} />
                  <Row k="Removed" v={stage?.docs_removed ?? 0} />
                  {stageName === "redacted" && (
                    <Row k="PII spans" v={stage?.pii_spans_redacted ?? 0} />
                  )}
                  <Row k="Shards" v={stage?.shard_count ?? 0} />
                  <Row k="Bytes" v={humanizeBytes(stage?.bytes_written ?? 0)} />
                </dl>
                {stage?.detail && (
                  <p className="text-xs text-muted-foreground">{stage.detail}</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <dt>{k}</dt>
      <dd className="font-mono text-foreground">{v}</dd>
    </div>
  );
}
