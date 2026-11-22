/** 値の表示形式(画面と通知で共用) */
const num = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 単位が bytes の場合は自動で KB/MB/GB に換算して表示(保存値は常に bytes) */
export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (unit.toLowerCase() === "bytes") {
    let v = value;
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    return `${num.format(v)} ${BYTE_UNITS[i]}`;
  }
  return `${num.format(value)} ${unit}`;
}

export const formatPercent = (p: number | null) => (p === null ? "—" : `${pct.format(p)}%`);

/** タイムゾーンを指定した日付(通知用。画面はブラウザのタイムゾーン) */
export function formatDateIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso)) + "(UTC)";
  }
}
