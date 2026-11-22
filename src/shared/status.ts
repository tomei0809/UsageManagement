import { computeForecast } from "./forecast";
import { currentPeriod, nextResetAt } from "./period";
import type { Metric, MetricStatus, Snapshot } from "./types";
import { computeUsage, isStale } from "./usage";

/**
 * 「現在値」として採用する記録の下限時刻。
 * cumulative かつ期間ありなら当期開始、それ以外(gauge / none)は制限なし。
 */
export function latestSince(metric: Metric, now: Date): string | null {
  if (metric.kind === "gauge") return null;
  return currentPeriod(metric, now)?.start.toISOString() ?? null;
}

export function buildMetricStatus(
  metric: Metric,
  latest: Snapshot | null,
  now: Date,
  baseline: Pick<Snapshot, "value" | "collectedAt"> | null = null,
): MetricStatus {
  const usage = computeUsage({
    value: latest?.value ?? null,
    limitValue: metric.limitValue,
    cautionPct: metric.cautionPct,
    warningPct: metric.warningPct,
  });
  return {
    metric,
    latest,
    ...usage,
    stale: isStale(latest?.collectedAt ?? null, metric.staleAfterHours, now),
    periodStart: currentPeriod(metric, now)?.start.toISOString() ?? null,
    nextResetAt: nextResetAt(metric, now)?.toISOString() ?? null,
    forecast: computeForecast(metric, latest, baseline, now),
  };
}
