"use client";

import Link from "next/link";
import { FlaskConical } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RunStatusBadge } from "@/components/runs/run-status-badge";
import { RunDeleteButton } from "@/components/runs/run-delete-button";
import { useRuns } from "@/lib/queries";
import { SOURCE_OPTIONS, labelFor } from "@/lib/run-options";
import { formatDate } from "@/lib/utils";

export function RunList() {
  const { data: runs = [], isLoading, error, refetch } = useRuns();

  if (error) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState error={error} onRetry={() => refetch()} />
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={FlaskConical}
            title="No curation runs yet"
            description="Create your first run to deduplicate, filter, and redact a corpus into versioned B2 stages."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Name
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Source
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground tabular-nums">
                Docs in &rarr; out
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Written
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Created
              </TableHead>
              <TableHead className="text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.run_id} className="table-row-hover">
                <TableCell className="font-medium">
                  <Link
                    href={`/runs/${run.run_id}`}
                    className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {run.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <RunStatusBadge status={run.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {labelFor(SOURCE_OPTIONS, run.source)}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {run.source_docs} &rarr; {run.final_docs}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                  {run.total_bytes_human}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {formatDate(run.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  <RunDeleteButton
                    runId={run.run_id}
                    runName={run.name}
                    iconOnly
                    disabled={run.status === "running"}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
