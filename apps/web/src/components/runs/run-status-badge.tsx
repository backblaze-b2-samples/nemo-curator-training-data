import { Badge } from "@/components/ui/badge";
import { STATUS_META } from "@/lib/run-options";
import type { RunStatus } from "@nemo-curator-training-data/shared";

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
