"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { BarChart3 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunStats } from "@/lib/queries";

const chartConfig = {
  documents: {
    label: "Documents",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export function StageFunnelChart() {
  const { data: stats, isLoading, error, refetch } = useRunStats();

  const data = useMemo(
    () =>
      (stats?.funnel ?? []).map((point) => ({
        stage: point.label,
        documents: point.documents,
      })),
    [stats],
  );

  const hasData = data.some((d) => d.documents > 0);

  return (
    <Card>
      <CardHeader className="border-b border-border py-4 px-5">
        <CardTitle className="card-title">Curation Funnel</CardTitle>
        <CardDescription className="text-xs">
          Documents surviving each stage, summed across all runs
        </CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        {isLoading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !hasData ? (
          <EmptyState
            icon={BarChart3}
            title="No completed stages yet"
            description="Run a curation pipeline to see documents flow through each stage."
          />
        ) : (
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="funnel-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-documents)" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="var(--color-documents)" stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="stage" tickLine={false} axisLine={false} tickMargin={10} fontSize={11} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tickMargin={6} fontSize={11} width={28} />
              <ChartTooltip cursor={{ fill: "var(--accent-subtle)" }} content={<ChartTooltipContent />} />
              <Bar
                dataKey="documents"
                fill="url(#funnel-fill)"
                radius={[4, 4, 0, 0]}
                animationDuration={500}
                animationEasing="ease-out"
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
