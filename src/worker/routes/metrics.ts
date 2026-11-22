import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { Hono } from "hono";
import { currentPeriod } from "../../shared/period";
import { dailySeries, lastNDays, monthlySeries } from "../../shared/series";
import type { SeriesResponse } from "../../shared/types";
import type { Env } from "../env";
import { metrics, snapshots } from "../db/schema";
import { getDb, nowIso } from "../lib/db";
import { parseBody, parseId } from "../lib/http";
import { metricInput, snapshotInput } from "../validation";
import { evaluateAlerts } from "../notify";

export const metricsRoute = new Hono<{ Bindings: Env }>()
  .put("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await parseBody(c, metricInput);
    const [row] = await getDb(c.env.DB)
      .update(metrics)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(metrics.id, id))
      .returning();
    return row ? c.json(row) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await getDb(c.env.DB).delete(metrics).where(eq(metrics.id, id)).returning({ id: metrics.id });
    return rows.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  })
  .get("/:id/snapshots", async (c) => {
    const id = parseId(c.req.param("id"));
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000);
    const rows = await getDb(c.env.DB)
      .select()
      .from(snapshots)
      .where(eq(snapshots.metricId, id))
      .orderBy(desc(snapshots.collectedAt))
      .limit(limit);
    return c.json(rows);
  })
  /** 日別・月別の集計。?granularity=day&days=30 / ?granularity=month&months=12 */
  .get("/:id/series", async (c) => {
    const id = parseId(c.req.param("id"));
    const granularity = c.req.query("granularity") === "month" ? "month" : "day";
    const db = getDb(c.env.DB);
    const metric = await db.query.metrics.findFirst({ where: eq(metrics.id, id) });
    if (!metric) return c.json({ error: "metric not found" }, 404);

    const now = new Date();
    const tz = metric.resetTimezone;
    let from: Date;
    let count: number;
    if (granularity === "day") {
      count = clamp(Number(c.req.query("days") ?? 30), 7, 400);
      from = lastNDays(now, count, tz).from;
    } else {
      count = clamp(Number(c.req.query("months") ?? 12), 1, 36);
      // 月別バケットの先頭より十分前から取得(先頭バケットの開始は monthlySeries 側で計算)
      from = new Date(now.getTime() - (count + 1) * 31 * 86_400_000);
    }

    // 範囲内の記録 + 範囲直前の 1 件(先頭の増加量を正しく求めるため)
    const fromIso = from.toISOString();
    const [inRange, before] = await db.batch([
      db
        .select({ value: snapshots.value, collectedAt: snapshots.collectedAt })
        .from(snapshots)
        .where(and(eq(snapshots.metricId, id), gte(snapshots.collectedAt, fromIso)))
        .orderBy(asc(snapshots.collectedAt)),
      db
        .select({ value: snapshots.value, collectedAt: snapshots.collectedAt })
        .from(snapshots)
        .where(and(eq(snapshots.metricId, id), lt(snapshots.collectedAt, fromIso)))
        .orderBy(desc(snapshots.collectedAt))
        .limit(1),
    ]);
    const all = [...before, ...inRange];

    const body: SeriesResponse =
      granularity === "day"
        ? { granularity, timezone: tz, daily: dailySeries(metric, all, from, now) }
        : { granularity, timezone: tz, monthly: monthlySeries(metric, all, now, count) };
    return c.json(body);
  })
  /** 手動入力 */
  .post("/:id/snapshots", async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await parseBody(c, snapshotInput);
    const db = getDb(c.env.DB);
    const metric = await db.query.metrics.findFirst({ where: eq(metrics.id, id) });
    if (!metric) return c.json({ error: "metric not found" }, 404);

    const collectedAt = input.collectedAt ? new Date(input.collectedAt) : new Date();
    const period = currentPeriod(metric, collectedAt);
    const [row] = await db
      .insert(snapshots)
      .values({
        metricId: id,
        value: input.value,
        collectedAt: collectedAt.toISOString(),
        periodStart: period?.start.toISOString() ?? null,
        periodEnd: period?.end.toISOString() ?? null,
        source: "manual",
        note: input.note,
      })
      .returning();
    // 手動入力でレベルが上がったら通知(レスポンスは待たせない)
    c.executionCtx.waitUntil(evaluateAlerts(c.env, db, new Date()).catch((e) => console.error("alerts", e)));
    return c.json(row, 201);
  });

export const snapshotsRoute = new Hono<{ Bindings: Env }>().delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  // 自動取得の記録は誤操作で消さないよう手動入力分のみ削除可
  const rows = await getDb(c.env.DB)
    .delete(snapshots)
    .where(and(eq(snapshots.id, id), eq(snapshots.source, "manual")))
    .returning({ id: snapshots.id });
  return rows.length ? c.body(null, 204) : c.json({ error: "not found (or not a manual entry)" }, 404);
});

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : min;
}
