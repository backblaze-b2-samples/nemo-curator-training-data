"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { useDeleteRun } from "@/lib/queries";
import type { ApiError } from "@/lib/api-client";

interface RunDeleteButtonProps {
  runId: string;
  runName: string;
  disabled?: boolean;
  iconOnly?: boolean;
  onDeleted?: () => void;
}

export function RunDeleteButton({
  runId,
  runName,
  disabled,
  iconOnly,
  onDeleted,
}: RunDeleteButtonProps) {
  const [open, setOpen] = useState(false);
  const deleteRun = useDeleteRun();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size={iconOnly ? "icon" : "sm"}
          className="h-8"
          disabled={disabled}
          aria-label={iconOnly ? `Delete ${runName}` : undefined}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {!iconOnly && "Delete"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this run?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the manifest and every stage shard for
            <strong> {runName}</strong> from Backblaze B2. The delete is scoped
            strictly to this run&apos;s prefix — no other run or data is touched.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={(event) => {
              event.preventDefault();
              deleteRun.mutate(runId, {
                onSuccess: () => {
                  setOpen(false);
                  toast.success("Run deleted");
                  onDeleted?.();
                },
                onError: (error) => {
                  setOpen(false);
                  toast.error("Could not delete run", {
                    description: (error as ApiError).message,
                  });
                },
              });
            }}
          >
            {deleteRun.isPending ? "Deleting..." : "Delete run"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
