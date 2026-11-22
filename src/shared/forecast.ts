/**
 * 超過予測(純粋関数)。予測値は保存せず、表示のたびに計算する(実測と混同しないため)。
 *
 * 累積型(cumulative かつ rolling / none 以外、上限あり):
 *   ペース = 直近 7 日の増加量 ÷ 経過時間。
 *   当期開始から 7 日未満、または比較できる記録がなければ「当期開始(値 0)からの平均」。
 *   期末予測 = 現在値 + ペース × 期末までの残り時間。上限に届く見込み日時も出す。
 * その時点の量(gauge、上限あり):
 *   直近 7 日の増え方から上限に届く日時(90 日以内のときだけ)。減っている・横ばいなら予測なし。
 */
import { currentPeriod } from "./period";
import type { Metric, Snapshot } from "./types";

export const FORECAST_WINDOW_DAYS = 7;
const DAY = 86_400_000;
const GAUGE_HORIZON_DAYS = 90;

export interface Forecast {
  /** 7d = 直近 7 日のペース / period = 当期開始からの平均 */
  method: "7d" | "period";
  pacePerDay: number;
  /** 期末時点の予測値(gauge は null) */
  projected: number | null;
  projectedPercent: number | null;
  /** 予測の終点(期末)。gauge は null */
  horizon: string | null;
  /** 上限に届く見込み日時(期末までに / gauge は 90 日以内に届かなければ null) */
  exceedAt: string | null;
  /** 現在は上限未満だが、期末までに(gauge は 90 日以内に)上限に届く見込み */
  willExceed: boolean;
}

type ForecastMetric = Pick<Metric, "kind" | "limitValue" | "resetType" | "resetAnchor" | "resetTimezone">;
type Point = Pick<Snapshot, "value" | "collectedAt">;

/** 比較用の記録を探す下限時刻(この時刻以降で最も古い記録を baseline にする) */
export function baselineSince(metric: ForecastMetric, latestAt: Date): string {
  const windowStart = latestAt.getTime() - FORECAST_WINDOW_DAYS * DAY;
  if (metric.kind === "cumulative") {
    const p = currentPeriod(metric, latestAt);
    if (p) return new Date(Math.max(windowStart, p.start.getTime())).toISOString();
  }
  return new Date(windowStart).toISOString();
}

export function computeForecast(
  metric: ForecastMetric,
  latest: Point | null,
  baseline: Point | null,
  now: Date,
): Forecast | null {
  const limit = metric.limitValue;
  if (!latest || limit === null || limit <= 0) return null;
  const latestAt = new Date(latest.collectedAt);

  if (metric.kind === "cumulative") {
    if (metric.resetType === "rolling" || metric.resetType === "none") return null;
    const period = currentPeriod(metric, latestAt);
    if (!period) return null;
    // 最新の記録が当期のものでなければ(リセット後まだ記録がない)予測しない
    const nowPeriod = currentPeriod(metric, now);
    if (!nowPeriod || nowPeriod.start.getTime() !== period.start.getTime()) return null;

    const periodLen = period.end.getTime() - period.start.getTime();
    const minSpan = Math.min(DAY, periodLen / 4); // 日次リセットは 6 時間

    // 当期開始から 7 日未満なら当期開始(値 0)から。7 日以上経っていれば直近 7 日内で最も古い記録から
    const periodStart = { at: period.start.getTime(), value: 0, method: "period" as const };
    const windowStart = latestAt.getTime() - FORECAST_WINDOW_DAYS * DAY;
    let base: { at: number; value: number; method: Forecast["method"] } = periodStart;
    if (period.start.getTime() <= windowStart && baseline) {
      const at = new Date(baseline.collectedAt).getTime();
      if (at >= period.start.getTime() && latestAt.getTime() - at >= minSpan) {
        base = { at, value: baseline.value, method: "7d" };
      }
    }
    const span = latestAt.getTime() - base.at;
    if (span < minSpan) return null;

    const pacePerMs = Math.max(0, (latest.value - base.value) / span);
    const projected = latest.value + pacePerMs * (period.end.getTime() - latestAt.getTime());
    let exceedAt: string | null = null;
    if (latest.value < limit && pacePerMs > 0) {
      const t = latestAt.getTime() + (limit - latest.value) / pacePerMs;
      if (t < period.end.getTime()) exceedAt = new Date(t).toISOString();
    }
    return {
      method: base.method,
      pacePerDay: pacePerMs * DAY,
      projected,
      projectedPercent: (projected / limit) * 100,
      horizon: period.end.toISOString(),
      exceedAt,
      willExceed: exceedAt !== null,
    };
  }

  // gauge
  if (!baseline) return null;
  const baseAt = new Date(baseline.collectedAt).getTime();
  const span = latestAt.getTime() - baseAt;
  if (span < DAY) return null;
  const pacePerMs = (latest.value - baseline.value) / span;
  if (pacePerMs <= 0) return null;
  let exceedAt: string | null = null;
  if (latest.value < limit) {
    const t = latestAt.getTime() + (limit - latest.value) / pacePerMs;
    if (t - now.getTime() <= GAUGE_HORIZON_DAYS * DAY) exceedAt = new Date(t).toISOString();
  }
  return {
    method: "7d",
    pacePerDay: pacePerMs * DAY,
    projected: null,
    projectedPercent: null,
    horizon: null,
    exceedAt,
    willExceed: exceedAt !== null,
  };
}
