import { collectorMeta } from "../../shared/collectors";
import { CollectorError, type Collector, type DailyReadings } from "./types";

const failing = (fields: Record<string, string>) => (fields.mode ?? "ok").trim() === "fail";

/** ローカル確認用(ENABLE_DEMO_COLLECTOR=true のときだけ有効)。外部 API を呼ばない */
export const demo: Collector = {
  meta: collectorMeta("demo")!,
  async collect({ fields, now }) {
    if (failing(fields)) throw new CollectorError("network", "デモ: 失敗モードのため取得に失敗しました");
    const value = (now.getUTCDate() - 1) * 3000 + now.getUTCHours() * 120 + now.getUTCMinutes();
    return [{ metricKey: "demo-requests", value }];
  },
  /** 1 日あたり 1000〜4000 の架空の使用量を月初から累計 */
  async backfill({ fields, now }) {
    if (failing(fields)) throw new CollectorError("network", "デモ: 失敗モードのため取得に失敗しました");
    const out: DailyReadings[] = [];
    let cum = 0;
    const ym = now.toISOString().slice(0, 8);
    for (let day = 1; day < now.getUTCDate(); day++) {
      cum += 1000 + ((day * 2731) % 3000);
      out.push({ date: `${ym}${String(day).padStart(2, "0")}`, readings: [{ metricKey: "demo-requests", value: cum }] });
    }
    return out;
  },
};
