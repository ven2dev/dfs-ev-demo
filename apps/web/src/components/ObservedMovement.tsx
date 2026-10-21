import type { EVHistoryEntry, WatchedProp } from "@/types";
import { formatEdgePoints } from "@/lib/analysisPresentation";

type Props = { snapshot: WatchedProp; sessionId?: string };
const validQuote = (point: EVHistoryEntry) => {
  const c = point.context;
  return c !== undefined && !!c.bookmakerKey && c.dataSource !== undefined
    && c.line !== undefined && Number.isFinite(c.line)
    && c.price !== undefined && Number.isFinite(c.price) && c.price > 1
    && c.marketProbability !== undefined && Number.isFinite(c.marketProbability)
    && c.marketProbability >= 0 && c.marketProbability <= 1;
};

export const ObservedMovement = ({ snapshot, sessionId }: Props) => {
  const points = sessionId && snapshot.historySessionId === sessionId
    ? [...new Map(snapshot.evHistory.filter(p => Number.isFinite(p.timestamp)
      && Number.isFinite(new Date(p.timestamp).getTime()) && Number.isFinite(p.evScore))
      .map(p => [p.timestamp, p])).values()].sort((a, b) => a.timestamp - b.timestamp)
    : [];
  const first = points[0];
  const last = points.at(-1);
  const context = first?.context;
  const comparable = first !== undefined && last !== undefined && validQuote(first)
    && context?.propId === snapshot.propId && points.every(p => validQuote(p)
      && p.context?.propId === context.propId && p.context?.bookmakerKey === context.bookmakerKey
      && p.context?.direction === context.direction && p.context?.sampleWindow === context.sampleWindow
      && p.context?.dataSource === context.dataSource);
  const unchanged = first && last && Math.abs(last.evScore - first.evScore) < 0.0005;

  return (
    <div className="mt-3 space-y-2 text-sm" aria-label="Observed movement">
      {points.length < 2 || !first || !last ? (
        <p className="text-zinc-600 dark:text-zinc-400">Collecting another observation for this page session…</p>
      ) : (
        <>
          {comparable && context && last.context ? (
            <>
              <p>{context.line === last.context.line ? `Line unchanged at ${context.line}`
                : `Line ${context.line} → ${last.context.line}`} at {context.bookmakerKey} ({context.direction}).</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Decimal price {context.price!.toFixed(2)} → {last.context.price!.toFixed(2)}; market probability{" "}
                {(context.marketProbability! * 100).toFixed(1)}% → {(last.context.marketProbability! * 100).toFixed(1)}%.
              </p>
            </>
          ) : <p className="text-xs text-zinc-600 dark:text-zinc-400">Quote context unavailable or changed; line and inputs may have changed.</p>}
          <p>
            Observed illustrative edge: {formatEdgePoints(first.evScore)} → {formatEdgePoints(last.evScore)}
            {unchanged ? " (no change)" : ` (${formatEdgePoints(last.evScore - first.evScore)} change)`}; since{" "}
            <time dateTime={new Date(first.timestamp).toISOString()} title={new Date(first.timestamp).toLocaleString()}>
              {new Date(first.timestamp).toLocaleString()}
            </time>.
          </p>
        </>
      )}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {snapshot.dataSource === "fixture" ? "Fixture/sample observations. " : ""}
        Observations while this page is open; history resets on reload. Not complete odds history.
      </p>
    </div>
  );
};
