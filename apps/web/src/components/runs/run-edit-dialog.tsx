"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  RunForm,
  configToFormValues,
  formValuesToConfig,
} from "@/components/runs/run-form";
import { useUpdateRun } from "@/lib/queries";
import type { ApiError } from "@/lib/api-client";
import type { RunManifest } from "@nemo-curator-training-data/shared";

export function RunEditDialog({
  run,
  disabled,
}: {
  run: RunManifest;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const updateRun = useUpdateRun();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8" disabled={disabled}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit run</DialogTitle>
          <DialogDescription>
            Update the run name and stage configuration. Editing is blocked while
            a run is executing.
          </DialogDescription>
        </DialogHeader>
        {/* Pre-filled from the run's real config; no default hints on edit. */}
        <RunForm
          showHints={false}
          submitting={updateRun.isPending}
          submitLabel="Save changes"
          defaultValues={configToFormValues(run.name, run.config)}
          onCancel={() => setOpen(false)}
          onSubmit={(values) => {
            updateRun.mutate(
              {
                runId: run.run_id,
                req: { name: values.name, config: formValuesToConfig(values) },
              },
              {
                onSuccess: () => {
                  setOpen(false);
                  toast.success("Run updated");
                },
                onError: (error) =>
                  toast.error("Could not update run", {
                    description: (error as ApiError).message,
                  }),
              },
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
