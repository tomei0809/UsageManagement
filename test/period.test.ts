import { describe, expect, it } from "vitest";
import { currentPeriod, nextResetAt, type ResetPolicy } from "../src/shared/period";

const iso = (d: Date | null | undefined) => d?.toISOString();
const p = (resetType: ResetPolicy["resetType"], resetAnchor: number | null, resetTimezone = "UTC"): ResetPolicy => ({
  resetType,
  resetAnchor,
  resetTimezone,
});

describe("currentPeriod", () => {
  it("daily UTC", () => {
    const r = currentPeriod(p("daily", null), new Date("2026-11-22T23:59:59Z"));
    expect(iso(r?.start)).toBe("2026-11-22T00:00:00.000Z");
    expect(iso(r?.end)).toBe("2026-11-23T00:00:00.000Z");
  });

  it("daily Asia/Tokyo (UTC+9)", () => {
    // 2026-11-22 01:00 JST = 2026-11-21T16:00Z
    const r = currentPeriod(p("daily", null, "Asia/Tokyo"), new Date("2026-11-21T16:00:00Z"));
    expect(iso(r?.start)).toBe("2026-11-21T15:00:00.000Z");
    expect(iso(r?.end)).toBe("2026-11-22T15:00:00.000Z");
  });

  it("monthly 1日リセット", () => {
    const r = currentPeriod(p("monthly", 1), new Date("2026-11-22T10:00:00Z"));
    expect(iso(r?.start)).toBe("2026-11-01T00:00:00.000Z");
    expect(iso(r?.end)).toBe("2026-12-01T00:00:00.000Z");
  });

  it("monthly 年またぎ", () => {
    const r = currentPeriod(p("monthly", 1), new Date("2026-12-31T23:00:00Z"));
    expect(iso(r?.end)).toBe("2027-01-01T00:00:00.000Z");
  });

  it("monthly アンカー日の前なら前月から", () => {
    const r = currentPeriod(p("monthly", 15), new Date("2026-11-10T00:00:00Z"));
    expect(iso(r?.start)).toBe("2026-10-15T00:00:00.000Z");
    expect(iso(r?.end)).toBe("2026-11-15T00:00:00.000Z");
  });

  it("monthly 31日アンカーは短い月で末日に丸める", () => {
    const feb = currentPeriod(p("monthly", 31), new Date("2027-02-28T12:00:00Z"));
    expect(iso(feb?.start)).toBe("2027-02-28T00:00:00.000Z");
    expect(iso(feb?.end)).toBe("2027-03-31T00:00:00.000Z");
    const earlyMar = currentPeriod(p("monthly", 31), new Date("2027-03-05T00:00:00Z"));
    expect(iso(earlyMar?.start)).toBe("2027-02-28T00:00:00.000Z");
  });

  it("weekly 月曜リセット", () => {
    // 2026-11-22 は日曜
    const r = currentPeriod(p("weekly", 1), new Date("2026-11-22T12:00:00Z"));
    expect(iso(r?.start)).toBe("2026-11-16T00:00:00.000Z");
    expect(iso(r?.end)).toBe("2026-11-23T00:00:00.000Z");
  });

  it("rolling 5時間", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    const r = currentPeriod(p("rolling", 5), now);
    expect(iso(r?.start)).toBe("2026-11-22T07:00:00.000Z");
    expect(nextResetAt(p("rolling", 5), now)).toBeNull();
  });

  it("none は期間なし", () => {
    expect(currentPeriod(p("none", null), new Date())).toBeNull();
  });
});
