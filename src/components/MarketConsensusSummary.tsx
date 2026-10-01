import type { MarketConsensus } from "@/types";

type MarketConsensusSummaryProps = {
  probability: number;
  direction: "over" | "under";
  line: number;
  consensus: MarketConsensus;
};

export function MarketConsensusSummary({
  probability,
  direction,
  line,
  consensus,
}: MarketConsensusSummaryProps) {
  const bookLabel = consensus.contributingBookCount === 1 ? "book" : "books";
  const methodLabel =
    consensus.method === "exact-line-median" ? "Exact-line median" : consensus.method;

  return (
    <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <div className="flex justify-between text-sm">
        <span>Market probability ({direction})</span>
        <span>
          {(probability * 100).toFixed(1)}% · {consensus.contributingBookCount} {bookLabel}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        {methodLabel} v{consensus.version} of each book&rsquo;s independently
        devigged Over/Under prices at line {line}. Book count reports market coverage,
        not confidence.
      </p>
    </div>
  );
}
