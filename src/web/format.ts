import { formatValue } from "../shared/format";

export { formatPercent, formatValue } from "../shared/format";

const dateTime = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" });
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : "—");
export const formatDate = (iso: string | null | undefined) => (iso ? dateOnly.format(new Date(iso)) : "—");

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "未記録";
  const diffMin = Math.round((now - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "たった今";
  if (diffMin < 60) return `${diffMin}分前`;
  const h = Math.round(diffMin / 60);
  if (h < 48) return `${h}時間前`;
  return `${Math.round(h / 24)}日前`;
}

/** datetime-local 入力値(ローカル時刻)⇔ ISO */
export function toLocalInput(d: Date): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

const compact = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

/** グラフ軸用の短い表記(単位はキャプションに出す。bytes のみ KB/MB/GB を付ける) */
export function formatAxis(value: number, unit: string): string {
  return unit.toLowerCase() === "bytes" ? formatValue(value, unit) : compact.format(value);
}

/** キャプションに添える単位表記 */
export const unitSuffix = (unit: string) => (unit.toLowerCase() === "bytes" ? "" : `(${unit})`);

/** bytes 軸用の切りのよい目盛り(例: 0, 4, 8, 12, 16 GB) */
export function byteTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  let base = 1;
  while (max / base >= 1024 && base < 1024 ** 4) base *= 1024;
  const raw = max / base / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max / base + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6 * base);
  return ticks;
}
