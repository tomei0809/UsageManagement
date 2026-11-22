import { describe, expect, it } from "vitest";
import { baselineSince, computeForecast } from "../src/shared/forecast";

const monthly = { kind: "cumulative" as const, limitValue: 2000, resetType: "monthly" as const, resetAnchor: 1, resetTimezone: "UTC" };
const pt = (collectedAt: string, value: number) => ({ collectedAt, value });

describe("computeForecast(累積型)", () => {
  it("直近 7 日のペースで期末を予測し、超過見込み日時を出す", () => {
    // 11/15 → 11/22 で 700 増 = 100/日。11/22 0:00 時点 1500、期末 12/1 まで 9 日 → 2400
    const f = computeForecast(monthly, pt("2026-11-22T00:00:00Z", 1500), pt("2026-11-15T00:00:00Z", 800), new Date("2026-11-22T01:00:00Z"))!;
    expect(f.method).toBe("7d");
    expect(f.pacePerDay).toBeCloseTo(100);
    expect(f.projected).toBeCloseTo(2400);
    expect(f.projectedPercent).toBeCloseTo(120);
    expect(f.willExceed).toBe(true);
    expect(f.exceedAt).toBe("2026-11-27T00:00:00.000Z");
  });

  it("使用率が低くても、ペースが速ければ超過見込み(要件 3-5 の例)", () => {
    // 6 日で 60%(1200)使用 → 期末には約 300%
    const f = computeForecast(monthly, pt("2026-11-07T00:00:00Z", 1200), null, new Date("2026-11-07T00:00:00Z"))!;
    expect(f.method).toBe("period");
    expect(f.willExceed).toBe(true);
  });

  it("ゆっくりなら超過見込みなし", () => {
    const f = computeForecast(monthly, pt("2026-11-22T00:00:00Z", 500), pt("2026-11-15T00:00:00Z", 400), new Date("2026-11-22T00:00:00Z"))!;
    expect(f.willExceed).toBe(false);
    expect(f.projected).toBeLessThan(2000);
  });

  it("当期開始から 7 日未満は当期開始からの平均", () => {
    const f = computeForecast(monthly, pt("2026-11-03T00:00:00Z", 100), pt("2026-11-02T00:00:00Z", 60), new Date("2026-11-03T00:00:00Z"))!;
    expect(f.method).toBe("period");
    expect(f.pacePerDay).toBeCloseTo(50);
  });

  it("データ不足(期間開始から 1 日未満)・上限なし・リセット後の記録なしは予測しない", () => {
    expect(computeForecast(monthly, pt("2026-11-01T06:00:00Z", 10), null, new Date("2026-11-01T06:00:00Z"))).toBeNull();
    expect(computeForecast({ ...monthly, limitValue: null }, pt("2026-11-22T00:00:00Z", 1), null, new Date("2026-11-22T00:00:00Z"))).toBeNull();
    expect(computeForecast(monthly, pt("2026-10-30T00:00:00Z", 900), null, new Date("2026-11-02T00:00:00Z"))).toBeNull();
  });

  it("日次リセットは 6 時間経てば予測", () => {
    const daily = { ...monthly, resetType: "daily" as const, limitValue: 100000 };
    const f = computeForecast(daily, pt("2026-11-22T06:00:00Z", 30000), null, new Date("2026-11-22T06:00:00Z"))!;
    expect(f.projected).toBeCloseTo(120000);
    expect(f.exceedAt).toBe("2026-11-22T20:00:00.000Z");
  });
});

describe("computeForecast(gauge)", () => {
  const gauge = { kind: "gauge" as const, limitValue: 100, resetType: "none" as const, resetAnchor: null, resetTimezone: "UTC" };
  it("増えていれば上限到達日(90 日以内)", () => {
    const f = computeForecast(gauge, pt("2026-11-22T00:00:00Z", 80), pt("2026-11-15T00:00:00Z", 66), new Date("2026-11-22T00:00:00Z"))!;
    expect(f.pacePerDay).toBeCloseTo(2);
    expect(f.exceedAt).toBe("2026-12-02T00:00:00.000Z");
    expect(f.projected).toBeNull();
  });
  it("横ばい・減少、90 日より先は超過見込みなし", () => {
    expect(computeForecast(gauge, pt("2026-11-22T00:00:00Z", 80), pt("2026-11-15T00:00:00Z", 80), new Date("2026-11-22T00:00:00Z"))).toBeNull();
    const slow = computeForecast(gauge, pt("2026-11-22T00:00:00Z", 10), pt("2026-11-15T00:00:00Z", 9.9), new Date("2026-11-22T00:00:00Z"))!;
    expect(slow.willExceed).toBe(false);
  });
});

describe("baselineSince", () => {
  it("累積型は当期開始より前を見ない", () => {
    expect(baselineSince(monthly, new Date("2026-11-03T00:00:00Z"))).toBe("2026-11-01T00:00:00.000Z");
    expect(baselineSince(monthly, new Date("2026-11-22T00:00:00Z"))).toBe("2026-11-15T00:00:00.000Z");
  });
});
