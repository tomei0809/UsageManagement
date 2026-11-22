/**
 * リセット方式から「現在の集計期間」と「次回リセット日時」を求める純粋関数。
 * タイムゾーンは IANA 名(例: "UTC", "Asia/Tokyo")。
 */
export type ResetType = "monthly" | "daily" | "weekly" | "rolling" | "none";

export interface ResetPolicy {
  resetType: ResetType;
  /** monthly: 日(1-31, 月末超過は末日に丸める) / weekly: 曜日(0=日) / rolling: 時間数 */
  resetAnchor: number | null;
  resetTimezone: string;
}

export interface Period {
  start: Date;
  /** 次回リセット日時(期間の終端・排他的)。rolling は「最も古い記録が外れる」時刻ではなく now を返す */
  end: Date;
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0=日
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function partsOf(date: Date, tz: string) {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday ?? "Sun"),
  };
}

export function wallClock(date: Date, tz: string): WallClock {
  const p = partsOf(date, tz);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

/** tz における UTC からのオフセット(ms) */
function offsetMs(date: Date, tz: string): number {
  const p = partsOf(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** tz の壁時計 y-m-d 00:00 を UTC の Date に変換(month は 1 始まり、範囲外は Date.UTC の繰り上げに従う) */
export function zonedMidnight(year: number, month: number, day: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - offsetMs(new Date(guess), tz);
  // DST 境界での補正(1回で十分)
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthlyStart(year: number, month: number, anchor: number, tz: string): Date {
  // month は繰り上げ・繰り下げを正規化
  const norm = new Date(Date.UTC(year, month - 1, 1));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth() + 1;
  return zonedMidnight(y, m, Math.min(anchor, daysInMonth(y, m)), tz);
}

/** 現在期間。resetType = "none" は期間なし(null) */
export function currentPeriod(policy: ResetPolicy, now: Date): Period | null {
  const tz = policy.resetTimezone || "UTC";
  const wc = wallClock(now, tz);
  switch (policy.resetType) {
    case "daily": {
      const start = zonedMidnight(wc.year, wc.month, wc.day, tz);
      const end = zonedMidnight(wc.year, wc.month, wc.day + 1, tz);
      return { start, end };
    }
    case "weekly": {
      const anchor = clampInt(policy.resetAnchor ?? 1, 0, 6);
      const back = (wc.weekday - anchor + 7) % 7;
      const start = zonedMidnight(wc.year, wc.month, wc.day - back, tz);
      const end = zonedMidnight(wc.year, wc.month, wc.day - back + 7, tz);
      return { start, end };
    }
    case "monthly": {
      const anchor = clampInt(policy.resetAnchor ?? 1, 1, 31);
      let start = monthlyStart(wc.year, wc.month, anchor, tz);
      if (start.getTime() > now.getTime()) start = monthlyStart(wc.year, wc.month - 1, anchor, tz);
      // start は常に「その月のアンカー日(末日に丸め済み)」なので、翌月のアンカー日が終端
      const sw = wallClock(start, tz);
      const end = monthlyStart(sw.year, sw.month + 1, anchor, tz);
      return { start, end };
    }
    case "rolling": {
      const hours = Math.max(1, policy.resetAnchor ?? 24);
      return { start: new Date(now.getTime() - hours * 3_600_000), end: now };
    }
    case "none":
      return null;
  }
}

/** 次回リセット日時。rolling / none は固定のリセット日時がないため null */
export function nextResetAt(policy: ResetPolicy, now: Date): Date | null {
  if (policy.resetType === "rolling" || policy.resetType === "none") return null;
  return currentPeriod(policy, now)?.end ?? null;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** tz における日付キー "YYYY-MM-DD" */
export function dateKey(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}
