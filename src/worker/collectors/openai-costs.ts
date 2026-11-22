import { collectorMeta } from "../../shared/collectors";
import { fetchJson, requireField } from "./http";
import { CollectorError, type Collector } from "./types";

export interface CostsPage {
  data: { results: { amount?: { value: number; currency: string } }[] }[];
  has_more: boolean;
  next_page: string | null;
}

export function sumCosts(pages: CostsPage[]): number {
  const currencies = new Set<string>();
  let total = 0;
  for (const p of pages)
    for (const b of p.data ?? [])
      for (const r of b.results ?? []) {
        if (!r.amount) continue;
        currencies.add(r.amount.currency.toLowerCase());
        total += r.amount.value;
      }
  const other = [...currencies].filter((c) => c !== "usd");
  if (other.length) throw new CollectorError("bad_response", `OpenAI costs: USD 以外の通貨が含まれています(${other.join(", ")})`);
  return Math.round(total * 100) / 100;
}

/** 当月(UTC 1 日 0 時〜)の料金合計。Costs API の bucket_width は 1d のみ */
export const openaiCosts: Collector = {
  meta: collectorMeta("openai-costs")!,
  async collect({ fields, now, fetch }) {
    const key = requireField(fields, "adminKey", "Admin キー");
    const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const pages: CostsPage[] = [];
    let page: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qs = new URLSearchParams({ start_time: String(start), bucket_width: "1d", limit: "31" });
      if (page) qs.set("page", page);
      const p: CostsPage = await fetchJson<CostsPage>(
        fetch,
        `https://api.openai.com/v1/organization/costs?${qs}`,
        { headers: { Authorization: `Bearer ${key}` } },
        "OpenAI costs",
      );
      pages.push(p);
      if (!p.has_more || !p.next_page) break;
      page = p.next_page;
    }
    return [{ metricKey: "openai-cost-usd", value: sumCosts(pages) }];
  },
};
