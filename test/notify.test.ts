import { describe, expect, it, vi } from "vitest";
import type { Forecast } from "../src/shared/forecast";
import type { DashboardResponse, MetricStatus } from "../src/shared/types";
import { decideAlerts, freeTierStep, sendDiscord, type AlertRow } from "../src/worker/notify";

const now = new Date("2026-11-22T12:00:00Z");

function dash(opts: { level?: MetricStatus["level"]; forecast?: Partial<Forecast> | null; periodStart?: string; freeTierEndsAt?: string | null; kind?: "cumulative" | "gauge" }): DashboardResponse {
  const metric = {
    id: 7, serviceId: 1, key: "m", label: "実行時間", unit: "minutes", kind: opts.kind ?? "cumulative", limitValue: 2000,
    resetType: "monthly", resetAnchor: 1, resetTimezone: "UTC", cautionPct: 80, warningPct: 95, staleAfterHours: 48,
    collectorId: null, pollingEnabled: true, pollIntervalHours: null, sortOrder: 0, createdAt: "", updatedAt: "",
  } as const;
  const status: MetricStatus = {
    metric: { ...metric },
    latest: { id: 1, metricId: 7, value: 1700, collectedAt: now.toISOString(), periodStart: null, periodEnd: null, source: "api", collectorRunId: null, note: null },
    percent: 85,
    remaining: 300,
    level: opts.level ?? "caution",
    stale: false,
    periodStart: opts.periodStart ?? "2026-11-01T00:00:00.000Z",
    nextResetAt: "2026-12-01T00:00:00.000Z",
    forecast:
      opts.forecast === null || opts.forecast === undefined
        ? null
        : ({ method: "7d", pacePerDay: 100, projected: 2600, projectedPercent: 130, horizon: "2026-12-01T00:00:00.000Z", exceedAt: "2026-11-25T00:00:00.000Z", willExceed: true, ...opts.forecast } as Forecast),
  };
  return {
    generatedAt: now.toISOString(),
    settings: { schedulerEnabled: true, autoPauseAfter: 5, notificationsEnabled: true, webhookHint: null },
    services: [
      {
        service: {
          id: 1, name: "GitHub Actions", category: null, url: null, notes: null, collectorId: null, collectorConfig: null,
          pollingEnabled: true, pausedUntil: null, pauseReason: null, consecutiveFailures: 0, lastRunAt: null, lastSuccessAt: null,
          lastError: null, nextRunAt: null, freeTierEndsAt: opts.freeTierEndsAt ?? null, pauseOnFreeTierEnd: false, createdAt: "", updatedAt: "",
        },
        pollState: "manual",
        metrics: [status],
      },
    ],
  };
}

const lv = (level: string, periodKey = "2026-11-01T00:00:00.000Z"): AlertRow => ({ kind: "level", subject: "m:7", periodKey, level });

describe("decideAlerts(使用率レベル)", () => {
  it("初めて注意になったら通知", () => {
    const d = decideAlerts(dash({ level: "caution" }), [], now, "Asia/Tokyo");
    expect(d.notices.map((n) => n.title)).toEqual(["注意: GitHub Actions / 実行時間"]);
    expect(d.upserts).toEqual([lv("caution")]);
  });
  it("同じレベルは再通知しない", () => {
    expect(decideAlerts(dash({ level: "caution" }), [lv("caution")], now, "UTC").notices).toHaveLength(0);
  });
  it("レベルが上がったら通知、下がっても通知しない", () => {
    expect(decideAlerts(dash({ level: "warning" }), [lv("caution")], now, "UTC").notices[0]!.title).toMatch(/^警告/);
    expect(decideAlerts(dash({ level: "caution" }), [lv("warning")], now, "UTC").notices).toHaveLength(0);
  });
  it("正常に戻ったら記録を消す(次に上がったら再通知できる)", () => {
    const d = decideAlerts(dash({ level: "ok" }), [lv("warning")], now, "UTC");
    expect(d.notices).toHaveLength(0);
    expect(d.deletes).toEqual([lv("warning")]);
  });
  it("期間が変われば再び通知(前期の記録は別キー)", () => {
    const d = decideAlerts(dash({ level: "caution", periodStart: "2026-12-01T00:00:00.000Z" }), [lv("limit")], now, "UTC");
    expect(d.notices).toHaveLength(1);
  });
});

describe("decideAlerts(超過見込み)", () => {
  it("初めて超過見込みになったら 1 回だけ", () => {
    const first = decideAlerts(dash({ level: "ok", forecast: {} }), [], now, "Asia/Tokyo");
    expect(first.notices.map((n) => n.title)).toEqual(["超過見込み: GitHub Actions / 実行時間"]);
    expect(first.notices[0]!.description).toContain("予測値は実測ではありません");
    const again = decideAlerts(dash({ level: "ok", forecast: {} }), first.upserts, now, "Asia/Tokyo");
    expect(again.notices).toHaveLength(0);
  });
  it("上限到達済みなら超過見込みは送らない", () => {
    const d = decideAlerts(dash({ level: "limit", forecast: {} }), [lv("limit")], now, "UTC");
    expect(d.notices).toHaveLength(0);
  });
});

describe("無料期間の終了", () => {
  it("段階は 30 / 7 / 0", () => {
    expect(freeTierStep("2027-02-01", now)).toBeNull();
    expect(freeTierStep("2026-12-10", now)).toBe(30);
    expect(freeTierStep("2026-11-25", now)).toBe(7);
    expect(freeTierStep("2026-11-22", now)).toBe(7); // 当日はまだ無料(翌 0 時 UTC に終了)
    expect(freeTierStep("2026-11-21", now)).toBe(0);
  });
  it("各段階で 1 回ずつ、飛ばした段階はまとめて 1 回", () => {
    const ft = (level: string): AlertRow => ({ kind: "free_tier", subject: "s:1", periodKey: "2026-11-25", level });
    const d1 = decideAlerts(dash({ level: "ok", freeTierEndsAt: "2026-11-25" }), [], now, "UTC");
    expect(d1.notices.map((n) => n.title)).toEqual(["無料期間の終了まであと 7 日以内: GitHub Actions"]);
    expect(decideAlerts(dash({ level: "ok", freeTierEndsAt: "2026-11-25" }), [ft("7")], now, "UTC").notices).toHaveLength(0);
    expect(decideAlerts(dash({ level: "ok", freeTierEndsAt: "2026-11-25" }), [ft("30")], now, "UTC").notices).toHaveLength(1);
  });
});

describe("sendDiscord", () => {
  it("メンションを無効化し、10 件ずつ送る", async () => {
    const bodies: unknown[] = [];
    const f = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.com/api/webhooks/1/x", Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, description: "@everyone", color: 1 })), f);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ allowed_mentions: { parse: [] } });
  });
  it("失敗はエラー(記録を更新しないため)", async () => {
    const f = vi.fn(async () => new Response("x", { status: 404 })) as unknown as typeof fetch;
    await expect(sendDiscord("https://discord.com/api/webhooks/1/x", [{ title: "t", description: "d", color: 1 }], f)).rejects.toThrow(/404/);
  });
});
