import { RunCreateDialog } from "@/components/runs/run-create-dialog";
import { RunList } from "@/components/runs/run-list";

export default function RunsPage() {
  return (
    <div className="space-y-8">
      <div className="animate-fade-in flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <h1 className="page-title">Curation Runs</h1>
          <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            Configure and run multi-stage NeMo Curator pipelines. Each stage
            writes versioned, sharded JSONL to Backblaze B2.
          </p>
        </div>
        <RunCreateDialog />
      </div>
      <div className="animate-fade-in-up stagger-2">
        <RunList />
      </div>
    </div>
  );
}
