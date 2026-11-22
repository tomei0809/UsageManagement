import { describe, expect, it } from "vitest";
import { backoffUntil, pollState, shouldAutoPause, shouldRunScheduled, type PollingFields } from "../src/shared/schedule";

const now = new Date("2026-11-22T12:00:00Z");
const base: PollingFields = { collectorId: "github-actions", pollingEnabled: true, pausedUntil: null, nextRunAt: null };

describe("pollState(停止の 3 階層)", () => {
  it("通常は実行", () => {
    expect(pollState(base, true, now)).toBe("active");
    expect(shouldRunScheduled(base, true, now)).toBe(true);
  });
  it("コレクター未設定は手動", () => expect(pollState({ ...base, collectorId: null }, true, now)).toBe("manual"));
  it("全体停止が最優先", () => {
    expect(pollState({ ...base, pollingEnabled: false }, false, now)).toBe("global-stopped");
    expect(shouldRunScheduled(base, false, now)).toBe(false);
  });
  it("サービス停止", () => expect(pollState({ ...base, pollingEnabled: false }, true, now)).toBe("stopped"));
  it("期限付き一時停止は期限が来たら自動再開", () => {
    expect(pollState({ ...base, pausedUntil: "2026-11-23T00:00:00Z" }, true, now)).toBe("paused");
    expect(pollState({ ...base, pausedUntil: "2026-11-22T11:59:00Z" }, true, now)).toBe("active");
  });
  it("バックオフ中は見送り、時刻を過ぎたら実行", () => {
    expect(pollState({ ...base, nextRunAt: "2026-11-22T18:00:00Z" }, true, now)).toBe("backoff");
    expect(pollState({ ...base, nextRunAt: "2026-11-22T06:00:00Z" }, true, now)).toBe("active");
  });
});

describe("backoffUntil", () => {
  const h = (d: Date | null) => (d ? Math.round((d.getTime() - now.getTime()) / 60_000) / 60 : null);
  it("1 回目は待たない、以降 12h → 24h → 48h(上限)", () => {
    expect(backoffUntil(1, now)).toBeNull();
    expect(h(backoffUntil(2, now))).toBeCloseTo(12 - 1 / 6);
    expect(h(backoffUntil(3, now))).toBeCloseTo(24 - 1 / 6);
    expect(h(backoffUntil(4, now))).toBeCloseTo(48 - 1 / 6);
    expect(h(backoffUntil(9, now))).toBeCloseTo(48 - 1 / 6);
  });
});

describe("shouldAutoPause", () => {
  it("閾値以上で自動停止、0 は無効", () => {
    expect(shouldAutoPause(4, 5)).toBe(false);
    expect(shouldAutoPause(5, 5)).toBe(true);
    expect(shouldAutoPause(99, 0)).toBe(false);
  });
});
