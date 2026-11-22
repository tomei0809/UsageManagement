/**
 * 履歴の日別・月別集計(純粋関数)。
 *
 * - 「累積型」(cumulative かつ rolling 以外): 記録値は期間内の累計なので、
 *   前回記録との差分を「増加量(=その日/月に使った量)」とする。期間が変わったら差分ではなく値そのもの。
 *   値が減った場合(入力ミスの修正など)は増加 0 とみなす。
 * - それ以外(gauge / rolling): その日/月の最後の記録値を使う。
 * バケットの区切りは指標のリセット基準タイムゾーン。
 */
import { currentPeriod, dateKey, wallClock, zonedMidnight, type ResetPolicy } from "./period";
import type { MetricKind } from "./types";

export interface SeriesMetric extends ResetPolicy {
  kind: MetricKind;
}

export interface SeriesSnapshot {
  value: number;
  collectedAt: string;
}

export interface DailyPoint {
  /** YYYY-MM-DD(指標のタイムゾーン) */
  date: string;
  /** その日に使った量(累積型のみ。記録がない日は null) */
  usage: number | null;
  /** その日の最後の記録値(累積型なら期間内累計) */
  value: number | null;
  /** この日の 0:00 にリセットされた */
  resetDay: boolean;
}

export interface MonthlyPoint {
  /** バケット開始日 YYYY-MM-DD */
  start: string;
  /** 表示ラベル */
  label: string;
  /** 累積型: 期間内の使用量合計 / それ以外: 最後の記録値。記録なしは null */
  value: number | null;
}

export function isAccumulating(m: SeriesMetric): boolean {
  return m.kind === "cumulative" && m.resetType !== "rolling";
}

interface Annotated {
  at: Date;
  value: number;
  increase: number;
}

/** 時系列順に並べ、各記録の増加量を求める(範囲より前の記録も渡すと先頭の差分が正しくなる) */
export function annotate(metric: SeriesMetric, snapshots: SeriesSnapshot[]): Annotated[] {
  const sorted = [...snapshots].sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
  const out: Annotated[] = [];
  let prevValue: number | null = null;
  let prevPeriod: string | null = null;
  for (const s of sorted) {
    const at = new Date(s.collectedAt);
    const period = currentPeriod(metric, at)?.start.toISOString() ?? "none";
    const increase = prevValue !== null && period === prevPeriod ? Math.max(0, s.value - prevValue) : s.value;
    out.push({ at, value: s.value, increase });
    prevValue = s.value;
    prevPeriod = period;
  }
  return out;
}

/** 範囲内の日付キーを順に列挙(from, to を含む) */
function eachDay(from: Date, to: Date, tz: string): { key: string; start: Date }[] {
  const w = wallClock(from, tz);
  const days: { key: string; start: Date }[] = [];
  const endKey = dateKey(to, tz);
  for (let i = 0; i < 1000; i++) {
    const start = zonedMidnight(w.year, w.month, w.day + i, tz);
    const key = dateKey(start, tz);
    days.push({ key, start });
    if (key >= endKey) break;
  }
  return days;
}

export function dailySeries(metric: SeriesMetric, snapshots: SeriesSnapshot[], from: Date, to: Date): DailyPoint[] {
  const tz = metric.resetTimezone || "UTC";
  const acc = isAccumulating(metric);
  const byDay = new Map<string, { usage: number; value: number }>();
  for (const a of annotate(metric, snapshots)) {
    const key = dateKey(a.at, tz);
    const cur = byDay.get(key);
    byDay.set(key, { usage: (cur?.usage ?? 0) + a.increase, value: a.value });
  }
  const showResets = metric.resetType === "monthly" || metric.resetType === "weekly";
  return eachDay(from, to, tz).map(({ key, start }) => {
    const d = byDay.get(key);
    return {
      date: key,
      usage: acc ? (d?.usage ?? null) : null,
      value: d?.value ?? null,
      resetDay: showResets && currentPeriod(metric, start)?.start.getTime() === start.getTime(),
    };
  });
}

/**
 * 月別。monthly リセットの指標はリセット期間ごと(例: 15日〜翌14日)、それ以外は暦月で区切る。
 * `months` 個のバケットを古い順に返す(最後が now を含むバケット)。
 */
export function monthlySeries(metric: SeriesMetric, snapshots: SeriesSnapshot[], now: Date, months: number): MonthlyPoint[] {
  const tz = metric.resetTimezone || "UTC";
  const policy: ResetPolicy =
    metric.resetType === "monthly" ? metric : { resetType: "monthly", resetAnchor: 1, resetTimezone: tz };

  // now を含むバケットから遡って境界を求める
  const buckets: { start: Date; end: Date }[] = [];
  let cursor = now;
  for (let i = 0; i < months; i++) {
    const p = currentPeriod(policy, cursor)!;
    buckets.unshift({ start: p.start, end: p.end });
    cursor = new Date(p.start.getTime() - 1);
  }

  const acc = isAccumulating(metric);
  const annotated = annotate(metric, snapshots);
  const calendar = (policy.resetAnchor ?? 1) === 1;

  return buckets.map(({ start, end }) => {
    const inBucket = annotated.filter((a) => a.at >= start && a.at < end);
    const w = wallClock(start, tz);
    const label = calendar ? `${w.year}/${String(w.month).padStart(2, "0")}` : `${w.year}/${w.month}/${w.day}〜`;
    let value: number | null = null;
    if (inBucket.length) {
      value = acc ? inBucket.reduce((s, a) => s + a.increase, 0) : inBucket[inBucket.length - 1]!.value;
    }
    return { start: dateKey(start, tz), label, value };
  });
}

/** 指定日数分の日別範囲(今日を含む) */
export function lastNDays(now: Date, days: number, tz: string): { from: Date; to: Date } {
  const w = wallClock(now, tz);
  return { from: zonedMidnight(w.year, w.month, w.day - (days - 1), tz), to: now };
}

/** 次回リセットまでの日数(切り上げ)。リセットなしは null */
export function daysUntil(target: string | null, now: Date): number | null {
  if (!target) return null;
  return Math.max(0, Math.ceil((new Date(target).getTime() - now.getTime()) / 86_400_000));
}
