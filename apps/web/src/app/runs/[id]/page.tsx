import { RunDetail } from "@/components/runs/run-detail";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RunDetail runId={id} />;
}
