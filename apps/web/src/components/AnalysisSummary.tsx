import type { ConnectionStatus, WatchedProp, WatchSelection } from "@/types";
import { getOddsProvenanceCopy } from "@/lib/oddsProvenance";
import { HitRateSummary } from "./HitRateSummary";
import { MarketConsensusSummary } from "./MarketConsensusSummary";
import { ResultFreshness } from "./ResultFreshness";
import { formatEdgePoints } from "@/lib/analysisPresentation";

type AnalysisSummaryProps = {
  snapshot?: WatchedProp;
  selection: WatchSelection;
  requestedWindow: 3 | 5 | 7;
  connectionStatus: ConnectionStatus;
};

const isProbability = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;

export const AnalysisSummary = ({ snapshot, selection, requestedWindow, connectionStatus }: AnalysisSummaryProps) => {
  const provenance = getOddsProvenanceCopy(snapshot?.dataSource);
  const score = snapshot?.evScore;
  const stages = snapshot?.stages;
  const estimateAvailable = isProbability(score?.modelProb) && isProbability(stages?.baseRate);
  const line = snapshot?.line;
  const lineAvailable = line !== undefined && Number.isFinite(line);
  const quote = snapshot?.quote;
  const quoteAvailable = quote && Number.isFinite(quote.price) && quote.price > 1
    && Number.isFinite(quote.line) && Number.isFinite(new Date(quote.timestamp).getTime());
  const consensus = snapshot?.marketConsensus;
  const marketAvailable = lineAvailable && isProbability(score?.impliedProb) && consensus !== undefined
    && Number.isInteger(consensus.contributingBookCount) && consensus.contributingBookCount > 0;
  const edgeAvailable = estimateAvailable && marketAvailable && score !== undefined && Number.isFinite(score.edge);

  return (
    <div className="mt-6 space-y-4">
      {snapshot && (
        <ResultFreshness snapshot={snapshot} requestedWindow={requestedWindow} connectionStatus={connectionStatus} />
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <section aria-label="Estimate" className="min-w-0 rounded-lg bg-zinc-100 p-4 dark:bg-zinc-900">
          <h3 className="font-medium">Estimate</h3>
          {estimateAvailable && score && stages ? (
            <div className="mt-3 space-y-3">
              <HitRateSummary rate={stages.baseRate} adjustedRate={score.modelProb} sampleSize={snapshot?.sampleSize} />
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm">
                <span>Illustrative adjusted estimate <em>(includes sample coverage data)</em></span>
                <span className="whitespace-nowrap tabular-nums">{(score.modelProb * 100).toFixed(1)}%</span>
              </div>
              <details className="text-xs text-zinc-600 dark:text-zinc-400">
                <summary className="flex min-h-11 cursor-pointer items-center underline">Adjustment details</summary>
                <p>Weather and coverage adjustments are illustrative, not calibrated.</p>
                <p className="mt-2">
                  {provenance.environment}: {isProbability(stages.afterEnvironment)
                    ? `${(stages.afterEnvironment * 100).toFixed(1)}%`
                    : "unavailable"}.
                </p>
              </details>
            </div>
          ) : <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Estimate unavailable. Waiting for a valid result.</p>}
          {snapshot?.recentStatAverage !== undefined && Number.isFinite(snapshot.recentStatAverage) && (
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
              Average · {snapshot.sampleSize === undefined ? "sample size unavailable" : `n = ${snapshot.sampleSize} games`}:{" "}
              {snapshot.recentStatAverage.toFixed(1)} {selection.propType.toLowerCase()} <em>({provenance.history})</em>
            </p>
          )}
        </section>

        <section aria-label="Market" className="min-w-0 rounded-lg bg-zinc-100 p-4 dark:bg-zinc-900">
          <h3 className="font-medium">Market</h3>
          <div className="mt-3 text-sm">
            <p className="font-medium">Watched offer</p>
            <p className="mt-1">{selection.bookmakerKey} · {selection.direction}{" "}
              {lineAvailable ? line : "— (line unavailable)"}
            </p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{provenance.line}.</p>
            {quoteAvailable && quote ? (
              <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                {quote.timestamp !== snapshot?.updatedAt || quote.line !== snapshot?.line || quote.dataSource !== snapshot?.dataSource ? "Earlier quote · " : ""}
                {quote.dataSource === "fixture" ? "Sample data · " : quote.dataSource === "live" ? "Live quote · " : "Quote source unavailable · "}
                Decimal price {quote.price.toFixed(2)} at line {quote.line}, {quote.bookmakerKey}; as of{" "}
                <time dateTime={new Date(quote.timestamp).toISOString()}>{new Date(quote.timestamp).toLocaleString()}</time>.
              </p>
            ) : <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Price unavailable.</p>}
          </div>
          <div className="mt-3">
            {marketAvailable && score && consensus && line !== undefined ? (
              <MarketConsensusSummary probability={score.impliedProb} direction={selection.direction} line={line} consensus={consensus} />
            ) : <p className="text-sm text-zinc-600 dark:text-zinc-400">Market consensus unavailable at this line.</p>}
          </div>
        </section>

        <section aria-label="Edge" className="min-w-0 rounded-lg bg-zinc-100 p-4 dark:bg-zinc-900">
          <h3 className="font-medium">Edge</h3>
          <p className="mt-3 text-sm">Illustrative edge vs. same-line market consensus <em>(includes sample coverage data)</em></p>
          {edgeAvailable && score ? (
            <p className={`mt-2 text-2xl font-medium tabular-nums ${score.edge > 0
              ? "text-green-700 dark:text-green-400" : score.edge < 0 ? "text-red-700 dark:text-red-400" : "text-zinc-900 dark:text-zinc-100"}`}>
              {formatEdgePoints(score.edge)}
            </p>
          ) : <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Edge unavailable. A valid estimate and same-line market consensus are needed.</p>}
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Percentage-point difference between the illustrative estimate and market probability. Not a return per stake.</p>
        </section>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">For information only. Estimates are not guarantees. Only risk what you can afford to lose.</p>
    </div>
  );
};
