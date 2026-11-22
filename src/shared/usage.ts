/** 使用率・残量・警告レベル・データ鮮度の計算(純粋関数。UI と Worker で共用) */

export type UsageLevel = "ok" | "caution" | "warning" | "limit" | "unknown";

export interface UsageInput {
  value: number | null;
  limitValue: number | null;
  cautionPct: number;
  warningPct: number;
}

export interface UsageResult {
  /** 0-100+(上限超過は 100 を超える)。上限なし・値なしは null */
  percent: number | null;
  /** 残量(負にならない)。上限なしは null */
  remaining: number | null;
  level: UsageLevel;
}

export function computeUsage(input: UsageInput): UsageResult {
  const { value, limitValue } = input;
  if (value === null || limitValue === null || limitValue <= 0) {
    return {
      percent: null,
      remaining: value !== null && limitValue !== null ? Math.max(0, limitValue - value) : null,
      level: "unknown",
    };
  }
  const percent = (value / limitValue) * 100;
  return {
    percent,
    remaining: Math.max(0, limitValue - value),
    level: levelFor(percent, input.cautionPct, input.warningPct),
  };
}

export function levelFor(percent: number, cautionPct: number, warningPct: number): UsageLevel {
  if (percent >= 100) return "limit";
  if (percent >= warningPct) return "warning";
  if (percent >= cautionPct) return "caution";
  return "ok";
}

/** 最終取得からの経過が staleAfterHours を超えたら「古いデータ」 */
export function isStale(collectedAt: string | null, staleAfterHours: number, now: Date): boolean {
  if (!collectedAt) return false;
  return now.getTime() - new Date(collectedAt).getTime() > staleAfterHours * 3_600_000;
}
