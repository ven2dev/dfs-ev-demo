type HitRateSummaryProps = {
  rate: number;
  adjustedRate: number;
  sampleSize?: number;
};

export const HitRateSummary = ({ rate, adjustedRate, sampleSize }: HitRateSummaryProps) => {
  const extreme = [rate, adjustedRate].some((value) =>
    ["0.0", "100.0"].includes((value * 100).toFixed(1))
  );
  const sample = sampleSize === undefined
    ? "Sample size unavailable"
    : `n = ${sampleSize} ${sampleSize === 1 ? "game" : "games"}`;

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-sm">
        <span>Recent hit rate · {sample}</span>
        <span className="whitespace-nowrap tabular-nums">{(rate * 100).toFixed(1)}%</span>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Small sample. Recent results are not a calibrated prediction.
      </p>
      {extreme && (
        <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-200">
          Low confidence — small samples do not establish a 0% or 100% chance.
        </p>
      )}
    </div>
  );
};
