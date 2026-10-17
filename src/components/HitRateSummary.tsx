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
      <div className="flex justify-between gap-3 text-sm">
        <span>Recent hit rate · {sample}</span>
        <span>{(rate * 100).toFixed(1)}%</span>
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
