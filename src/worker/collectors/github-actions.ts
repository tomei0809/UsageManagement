import { collectorMeta } from "../../shared/collectors";
import { fetchJson, requireField } from "./http";
import { CollectorError, type Collector, type DailyReadings } from "./types";

interface SummaryItem {
  product: string;
  sku: string;
  unitType: string;
  grossQuantity: number;
  netAmount: number;
}
interface UsageItem {
  product: string;
  sku: string;
  unitType: string;
  quantity: number;
  netAmount: number;
}

const isMinutes = (unitType: string) => /minute/i.test(unitType ?? "");
const isActions = (product: string) => (product ?? "").toLowerCase() === "actions";

/** /usage/summary の集計(テスト用に export) */
export function sumSummary(items: SummaryItem[]) {
  const actions = items.filter((i) => isActions(i.product));
  return {
    minutes: actions.filter((i) => isMinutes(i.unitType)).reduce((s, i) => s + (i.grossQuantity ?? 0), 0),
    netUsd: actions.reduce((s, i) => s + (i.netAmount ?? 0), 0),
  };
}

/** /usage の集計(テスト用に export) */
export function sumUsage(items: UsageItem[]) {
  const actions = items.filter((i) => isActions(i.product));
  return {
    minutes: actions.filter((i) => isMinutes(i.unitType)).reduce((s, i) => s + (i.quantity ?? 0), 0),
    netUsd: actions.reduce((s, i) => s + (i.netAmount ?? 0), 0),
  };
}

/**
 * GitHub の課金 API(ユーザー)。
 * 1. /usage/summary?product=actions(パブリックプレビュー)を試す
 * 2. 404 なら /usage(enhanced billing platform のみ)にフォールバック
 * ユーザー向けエンドポイントが Actions を含むかは公式に明記がないため、実アカウントで要検証。
 */
function request(fields: Record<string, string>) {
  const username = encodeURIComponent(requireField(fields, "username", "GitHub ユーザー名"));
  const token = requireField(fields, "token", "トークン");
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "usage-management-app",
    },
  };
  return { init, base: `https://api.github.com/users/${username}/settings/billing` };
}

const toReadings = (t: { minutes: number; netUsd: number }) => [
  { metricKey: "actions-minutes", value: t.minutes },
  { metricKey: "actions-net-usd", value: Math.round(t.netUsd * 100) / 100 },
];

export const githubActions: Collector = {
  meta: collectorMeta("github-actions")!,

  /**
   * 当月 1 日〜昨日を 1 日ずつ /usage/summary?day=N で取得し、月初からの累計にする。
   * day は公式に「指定した 1 日の結果だけを返す」と記載されている(/usage の date 形式は記載がないため使わない)。
   */
  async backfill({ fields, now, fetch }) {
    const { init, base } = request(fields);
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const out: DailyReadings[] = [];
    const cum = { minutes: 0, netUsd: 0 };
    for (let day = 1; day < now.getUTCDate(); day++) {
      const r = await fetchJson<{ usageItems: SummaryItem[] }>(
        fetch,
        `${base}/usage/summary?year=${year}&month=${month}&day=${day}&product=actions`,
        init,
        `GitHub usage summary (${month}/${day})`,
      );
      const t = sumSummary(r.usageItems ?? []);
      cum.minutes += t.minutes;
      cum.netUsd += t.netUsd;
      out.push({
        date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        readings: toReadings(cum),
      });
    }
    return out;
  },

  async collect({ fields, now, fetch }) {
    const { init, base } = request(fields);
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    let totals: { minutes: number; netUsd: number };
    try {
      const r = await fetchJson<{ usageItems: SummaryItem[] }>(
        fetch,
        `${base}/usage/summary?year=${year}&month=${month}&product=actions`,
        init,
        "GitHub usage summary",
      );
      totals = sumSummary(r.usageItems ?? []);
    } catch (e) {
      if (!(e instanceof CollectorError) || e.kind !== "not_supported") throw e;
      const r = await fetchJson<{ usageItems: UsageItem[] }>(
        fetch,
        `${base}/usage?year=${year}&month=${month}`,
        init,
        "GitHub usage",
      );
      totals = sumUsage(r.usageItems ?? []);
    }
    return toReadings(totals);
  },
};
