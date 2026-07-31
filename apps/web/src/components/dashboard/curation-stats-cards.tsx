"use client";

import { FlaskConical, HardDrive, ShieldCheck, Scissors, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingNotice } from "@/components/common/loading-notice";
import { useRunStats } from "@/lib/queries";

export function CurationStatsCards() {
  const { data: stats, isLoading, error, refetch } = useRunStats();

  if (error) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState error={error} onRetry={() => refetch()} />
        </CardContent>
      </Card>
    );
  }

  const cards = [
    { title: "Total Runs", value: stats?.total_runs ?? 0, icon: FlaskConical },
    {
      title: "Documents Processed",
      value: stats?.documents_processed ?? 0,
      icon: Layers,
    },
    {
      title: "Documents Removed",
      value: stats?.documents_removed ?? 0,
      icon: Scissors,
    },
    {
      title: "PII Spans Redacted",
      value: stats?.pii_spans_redacted ?? 0,
      icon: ShieldCheck,
    },
    {
      title: "Written to B2",
      value: stats?.total_bytes_human ?? "0 B",
      icon: HardDrive,
    },
  ];

  return (
    <>
      {isLoading && <LoadingNotice className="mb-3" subject="curation stats" />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map((card, i) => (
          <Card
            key={card.title}
            className={`card-hover animate-fade-in-up stagger-${i + 1}`}
          >
            <CardHeader className="flex flex-row items-center justify-between pt-4 pb-2 px-4 space-y-0">
              <CardTitle className="text-xs font-semibold text-muted-foreground">
                {card.title}
              </CardTitle>
              <div className="stat-icon-wrap">
                <card.icon className="h-4 w-4" />
              </div>
            </CardHeader>
            <CardContent className="pb-5 px-4">
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <div className="stat-value">{card.value}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
