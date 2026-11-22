import { describe, expect, it, vi } from "vitest";
import { planBackfill } from "../src/worker/backfill";
import { githubActions } from "../src/worker/collectors/github-actions";

describe("GitHub Actions backfill", () => {
  it("1 日〜昨日を day 指定で取得し、月初からの累計にする", async () => {
    const perDay: Record<number, number> = { 1: 10, 2: 0, 3: 25 };
    const urls: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const day = Number(new URL(url).searchParams.get("day"));
      return new Response(
        JSON.stringify({
          usageItems: [{ product: "Actions", sku: "linux", unitType: "Minutes", grossQuantity: perDay[day] ?? 0, netAmount: 0 }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await githubActions.backfill!({
      fields: { username: "octo", token: "t" },
      now: new Date("2026-11-04T05:00:00Z"),
      fetch: f,
    });
    expect(urls).toHaveLength(3); // 当日(4 日)は含めない
    expect(urls[0]).toContain("year=2026&month=11&day=1&product=actions");
    expect(r.map((d) => [d.date, d.readings[0]!.value])).toEqual([
      ["2026-11-01", 10],
      ["2026-11-02", 10],
      ["2026-11-03", 35],
    ]);
  });

  it("1 日は過去分なし(API を呼ばない)", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const r = await githubActions.backfill!({ fields: { username: "o", token: "t" }, now: new Date("2026-12-01T03:00:00Z"), fetch: f });
    expect(r).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("planBackfill", () => {
  const daily = [
    { date: "2026-11-01", readings: [{ metricKey: "m", value: 10 }, { metricKey: "x", value: 1 }] },
    { date: "2026-11-02", readings: [{ metricKey: "m", value: 15 }] },
    { date: "bad", readings: [{ metricKey: "m", value: 99 }] },
  ];
  it("実記録のある日・対象外の指標・不正な日付は保存しない", () => {
    const plan = planBackfill(daily, new Map([["m", 7]]), new Map([[7, new Set(["2026-11-02"])]]));
    expect(plan).toEqual([{ metricId: 7, value: 10, collectedAt: "2026-11-01T23:59:59.999Z" }]);
  });
});
