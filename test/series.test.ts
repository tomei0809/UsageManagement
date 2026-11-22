import { describe, expect, it } from "vitest";
import { annotate, dailySeries, daysUntil, lastNDays, monthlySeries, type SeriesMetric } from "../src/shared/series";

const monthly: SeriesMetric = { kind: "cumulative", resetType: "monthly", resetAnchor: 1, resetTimezone: "UTC" };
const snap = (collectedAt: string, value: number) => ({ collectedAt, value });

describe("annotate", () => {
  it("同一期間は差分、期間が変わったら値そのもの、減少は 0", () => {
    const a = annotate(monthly, [
      snap("2026-10-30T00:00:00Z", 1800),
      snap("2026-11-02T00:00:00Z", 100),
      snap("2026-11-05T00:00:00Z", 400),
      snap("2026-11-06T00:00:00Z", 350),
    ]);
    expect(a.map((x) => x.increase)).toEqual([1800, 100, 300, 0]);
  });
});

describe("dailySeries", () => {
  it("日ごとの使用量・記録なしの日は null・リセット日の印", () => {
    const pts = dailySeries(
      monthly,
      [
        snap("2026-10-31T06:00:00Z", 1500), // 範囲外(前回値として使われる)
        snap("2026-11-01T06:00:00Z", 50),
        snap("2026-11-01T18:00:00Z", 80),
        snap("2026-11-03T12:00:00Z", 200),
      ],
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-03T23:00:00Z"),
    );
    expect(pts).toEqual([
      { date: "2026-11-01", usage: 80, value: 80, resetDay: true },
      { date: "2026-11-02", usage: null, value: null, resetDay: false },
      { date: "2026-11-03", usage: 120, value: 200, resetDay: false },
    ]);
  });

  it("gauge は usage を出さず最後の値", () => {
    const g: SeriesMetric = { kind: "gauge", resetType: "none", resetAnchor: null, resetTimezone: "UTC" };
    const pts = dailySeries(
      g,
      [snap("2026-11-01T01:00:00Z", 10), snap("2026-11-01T20:00:00Z", 12)],
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-01T23:00:00Z"),
    );
    expect(pts).toEqual([{ date: "2026-11-01", usage: null, value: 12, resetDay: false }]);
  });

  it("タイムゾーンで日付を区切る", () => {
    const jst: SeriesMetric = { ...monthly, resetTimezone: "Asia/Tokyo" };
    const { from, to } = lastNDays(new Date("2026-11-02T03:00:00Z"), 2, "Asia/Tokyo");
    const pts = dailySeries(jst, [snap("2026-11-01T16:00:00Z", 5)], from, to); // = 11/2 01:00 JST
    expect(pts.map((p) => [p.date, p.usage])).toEqual([
      ["2026-11-01", null],
      ["2026-11-02", 5],
    ]);
  });
});

describe("monthlySeries", () => {
  it("monthly リセットは期間ごとの使用量合計", () => {
    const pts = monthlySeries(
      monthly,
      [snap("2026-10-10T00:00:00Z", 300), snap("2026-10-28T00:00:00Z", 1700), snap("2026-11-20T00:00:00Z", 900)],
      new Date("2026-11-22T00:00:00Z"),
      3,
    );
    expect(pts).toEqual([
      { start: "2026-09-01", label: "2026/09", value: null },
      { start: "2026-10-01", label: "2026/10", value: 1700 },
      { start: "2026-11-01", label: "2026/11", value: 900 },
    ]);
  });

  it("日次リセットの指標は暦月に各日の使用量を合計", () => {
    const daily: SeriesMetric = { kind: "cumulative", resetType: "daily", resetAnchor: null, resetTimezone: "UTC" };
    const pts = monthlySeries(
      daily,
      [snap("2026-11-01T10:00:00Z", 1000), snap("2026-11-01T20:00:00Z", 3000), snap("2026-11-02T05:00:00Z", 500)],
      new Date("2026-11-22T00:00:00Z"),
      1,
    );
    expect(pts[0]?.value).toBe(3500);
  });

  it("アンカー日 15 は期間ラベル", () => {
    const m15: SeriesMetric = { ...monthly, resetAnchor: 15 };
    const pts = monthlySeries(m15, [], new Date("2026-11-22T00:00:00Z"), 2);
    expect(pts.map((p) => p.label)).toEqual(["2026/10/15〜", "2026/11/15〜"]);
  });
});

describe("daysUntil", () => {
  it("切り上げ日数", () => {
    expect(daysUntil("2026-12-01T00:00:00Z", new Date("2026-11-22T12:00:00Z"))).toBe(9);
    expect(daysUntil(null, new Date())).toBeNull();
  });
});
