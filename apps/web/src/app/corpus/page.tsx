import { CorpusExplorer } from "@/components/corpus/corpus-explorer";

export default async function CorpusPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run } = await searchParams;
  return (
    <div className="space-y-8">
      <div className="animate-fade-in border-b border-border pb-5">
        <h1 className="page-title">Corpus Explorer</h1>
        <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
          Browse a run&apos;s curated shards by stage, scoped to this app&apos;s
          own <code>nemo-curator/</code> B2 prefix. Preview the first documents
          of any shard or download it directly.
        </p>
      </div>
      <div className="animate-fade-in-up stagger-2">
        <CorpusExplorer initialRunId={run ?? null} />
      </div>
    </div>
  );
}
