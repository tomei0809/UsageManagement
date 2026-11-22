import { describe, expect, it } from "vitest";
import { computeUsage, isStale } from "../src/shared/usage";

const base = { cautionPct: 80, warningPct: 95 };

describe("computeUsage", () => {
  it("使用率と残量", () => {
    expect(computeUsage({ ...base, value: 1360, limitValue: 2000 })).toEqual({
      percent: 68,
      remaining: 640,
      level: "ok",
    });
  });

  it("閾値レベル", () => {
    expect(computeUsage({ ...base, value: 80, limitValue: 100 }).level).toBe("caution");
    expect(computeUsage({ ...base, value: 95, limitValue: 100 }).level).toBe("warning");
    expect(computeUsage({ ...base, value: 100, limitValue: 100 }).level).toBe("limit");
  });

  it("上限超過は残量 0・使用率 100 超", () => {
    const r = computeUsage({ ...base, value: 120, limitValue: 100 });
    expect(r.percent).toBe(120);
    expect(r.remaining).toBe(0);
    expect(r.level).toBe("limit");
  });

  it("上限なし・値なしは unknown", () => {
    expect(computeUsage({ ...base, value: 10, limitValue: null }).level).toBe("unknown");
    expect(computeUsage({ ...base, value: null, limitValue: 100 })).toEqual({
      percent: null,
      remaining: null,
      level: "unknown",
    });
  });

  it("メトリクス別の閾値", () => {
    expect(computeUsage({ cautionPct: 50, warningPct: 70, value: 60, limitValue: 100 }).level).toBe("caution");
  });
});

describe("isStale", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  it("経過時間で判定", () => {
    expect(isStale("2026-11-20T11:00:00Z", 48, now)).toBe(true);
    expect(isStale("2026-11-21T12:00:00Z", 48, now)).toBe(false);
    expect(isStale(null, 48, now)).toBe(false);
  });
});
