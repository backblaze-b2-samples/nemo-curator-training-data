import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CurationStatsCards } from "@/components/dashboard/curation-stats-cards";
import { RecentRunsTable } from "@/components/dashboard/recent-runs-table";
import { StageFunnelChart } from "@/components/dashboard/stage-funnel-chart";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <div className="animate-fade-in border-b border-border pb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Corpus curation activity and write amplification across your
            Backblaze B2 stages.
          </p>
        </div>
        <Button asChild size="sm" className="h-8">
          <Link href="/runs">
            <Plus className="h-3.5 w-3.5" />
            New run
          </Link>
        </Button>
      </div>
      <CurationStatsCards />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="animate-fade-in-up stagger-3">
          <StageFunnelChart />
        </div>
        <div className="animate-fade-in-up stagger-4">
          <RecentRunsTable />
        </div>
      </div>
    </div>
  );
}
