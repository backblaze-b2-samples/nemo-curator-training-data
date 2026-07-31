"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
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
import { useCreateRun } from "@/lib/queries";
import { DEFAULT_RUN_CONFIG } from "@/lib/run-options";
import type { ApiError } from "@/lib/api-client";

export function RunCreateDialog() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const createRun = useCreateRun();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8">
          <Plus className="h-3.5 w-3.5" />
          New run
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New curation run</DialogTitle>
          <DialogDescription>
            Configure a multi-stage NeMo Curator pipeline. Each stage&apos;s
            output is written as versioned, sharded JSONL to Backblaze B2.
          </DialogDescription>
        </DialogHeader>
        <RunForm
          showHints
          submitting={createRun.isPending}
          submitLabel="Create run"
          defaultValues={configToFormValues("", DEFAULT_RUN_CONFIG)}
          onCancel={() => setOpen(false)}
          onSubmit={(values) => {
            createRun.mutate(
              { name: values.name, config: formValuesToConfig(values) },
              {
                onSuccess: (run) => {
                  setOpen(false);
                  toast.success("Run created");
                  router.push(`/runs/${run.run_id}`);
                },
                onError: (error) =>
                  toast.error("Could not create run", {
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
