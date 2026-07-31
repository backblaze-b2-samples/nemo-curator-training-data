"use client";

import { useState } from "react";
import { Download, Eye, FolderOpen, Layers } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { getRunShardDownload } from "@/lib/api-client";
import { useRunDocument, useRunShards, useRuns } from "@/lib/queries";
import { STAGE_LABELS, STAGE_ORDER } from "@/lib/run-options";
import type { StageName } from "@nemo-curator-training-data/shared";

export function CorpusExplorer({ initialRunId }: { initialRunId: string | null }) {
  const { data: runs = [], isLoading: runsLoading, error: runsError, refetch } =
    useRuns();
  const [selectedRun, setSelectedRun] = useState<string | null>(initialRunId);
  const [stage, setStage] = useState<StageName>("raw");
  const [previewShard, setPreviewShard] = useState<string | null>(null);

  const activeRunId = selectedRun ?? runs[0]?.run_id ?? null;

  const shardsQuery = useRunShards(activeRunId ?? "", stage, {
    enabled: !!activeRunId,
  });
  const preview = useRunDocument(
    activeRunId ?? "",
    stage,
    previewShard ?? undefined,
    20,
    { enabled: !!activeRunId && !!previewShard },
  );

  async function handleDownload(shardKey: string) {
    if (!activeRunId) return;
    try {
      const { url } = await getRunShardDownload(activeRunId, stage, shardKey);
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      a.click();
    } catch {
      toast.error("Could not create a download link for that shard");
    }
  }

  if (runsError) {
    return <ErrorState error={runsError} onRetry={() => refetch()} />;
  }
  if (runsLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={FolderOpen}
            title="No curated shards yet"
            description="Create and run a curation pipeline first — its stage outputs appear here, scoped to this app's nemo-curator/ B2 prefix."
          />
        </CardContent>
      </Card>
    );
  }

  const shards = shardsQuery.data?.shards ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Select
          value={activeRunId ?? ""}
          onValueChange={(v) => {
            setSelectedRun(v);
            setPreviewShard(null);
          }}
        >
          <SelectTrigger className="w-full sm:w-96">
            <SelectValue placeholder="Select a run" />
          </SelectTrigger>
          <SelectContent>
            {runs.map((run) => (
              <SelectItem key={run.run_id} value={run.run_id}>
                {run.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs
          value={stage}
          onValueChange={(v) => {
            setStage(v as StageName);
            setPreviewShard(null);
          }}
        >
          <TabsList>
            {STAGE_ORDER.map((s) => (
              <TabsTrigger key={s} value={s}>
                {STAGE_LABELS[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <CardHeader className="border-b border-border py-4 px-5">
          <CardTitle className="card-title">
            {STAGE_LABELS[stage]} shards
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {shardsQuery.isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : shardsQuery.error ? (
            <ErrorState
              error={shardsQuery.error}
              onRetry={() => shardsQuery.refetch()}
            />
          ) : shards.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No shards for this stage"
              description="This stage may be skipped in the run's config, or the run hasn't executed yet."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Shard
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Size
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shards.map((shard) => (
                  <TableRow key={shard.key} className="table-row-hover">
                    <TableCell className="font-mono text-xs">
                      {shard.filename}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {shard.size_human}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={() => setPreviewShard(shard.key)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Preview
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={() => handleDownload(shard.key)}
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!previewShard}
        onOpenChange={(o) => !o && setPreviewShard(null)}
      >
        <DialogContent className="max-h-[85vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Document preview</DialogTitle>
            <DialogDescription>
              First {preview.data?.returned ?? 0} documents
              {preview.data?.truncated ? " (shard has more)" : ""} of{" "}
              {previewShard?.split("/").pop()}
            </DialogDescription>
          </DialogHeader>
          {preview.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : preview.error ? (
            <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
          ) : (
            <ScrollArea className="h-[60vh] rounded-md border border-border">
              <div className="space-y-3 p-4">
                {(preview.data?.documents ?? []).map((doc, i) => (
                  <pre
                    key={i}
                    className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs"
                  >
                    {JSON.stringify(doc, null, 2)}
                  </pre>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
