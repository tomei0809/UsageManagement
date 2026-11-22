import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { CollectorConnection } from "../../shared/types";
import { runBackfill } from "../backfill";
import { runService } from "../collect";
import { CollectorError } from "../collectors/types";
import { getCollector, listCollectors } from "../collectors/registry";
import { collectorRuns, credentials, metrics, services } from "../db/schema";
import { allowDemo, type Env } from "../env";
import { decryptJson, encryptJson, secretHint } from "../lib/crypto";
import { getDb, nowIso } from "../lib/db";
import { parseBody, parseId } from "../lib/http";
import { getSettings, getWebhookUrl, logEvent, saveSettings, setWebhookUrl } from "../lib/settings";
import { evaluateAlerts, sendDiscord } from "../notify";

const connectInput = z.object({
  collectorId: z.string().min(1),
  /** 秘密フィールドは空欄なら既存の値を維持 */
  fields: z.record(z.string(), z.string().max(4000)),
});

const pollingInput = z.object({
  enabled: z.boolean(),
  pausedUntil: z.iso.datetime({ offset: true }).nullish(),
  reason: z.string().trim().max(200).nullish(),
});

const settingsInput = z.object({
  schedulerEnabled: z.boolean(),
  autoPauseAfter: z.number().int().min(0).max(100),
  notificationsEnabled: z.boolean(),
});

const webhookInput = z.object({
  /** 空文字で削除 */
  url: z
    .string()
    .trim()
    .max(500)
    .refine(
      (u) => u === "" || /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(u),
      "Discord の Webhook URL(https://discord.com/api/webhooks/…)を入力してください",
    ),
});

export const collectorsRoute = new Hono<{ Bindings: Env }>().get("/", (c) =>
  c.json(listCollectors({ allowDemo: allowDemo(c.env) })),
);

export const settingsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => c.json(await getSettings(getDb(c.env.DB))))
  .put("/", async (c) => {
    const input = await parseBody(c, settingsInput);
    const db = getDb(c.env.DB);
    const before = await getSettings(db);
    await saveSettings(db, input);
    if (before.schedulerEnabled !== input.schedulerEnabled) {
      await logEvent(db, input.schedulerEnabled ? "scheduler_resume" : "scheduler_stop", "app");
    }
    if (before.notificationsEnabled !== input.notificationsEnabled) {
      await logEvent(db, input.notificationsEnabled ? "notifications_resume" : "notifications_stop", "app");
    }
    return c.json(await getSettings(db));
  })
  .put("/webhook", async (c) => {
    const { url } = await parseBody(c, webhookInput);
    const db = getDb(c.env.DB);
    await setWebhookUrl(c.env, db, url || null);
    await logEvent(db, url ? "webhook_set" : "webhook_delete", "app");
    return c.json(await getSettings(db));
  })
  /** テスト送信(通知のオン/オフに関係なく送る) */
  .post("/webhook/test", async (c) => {
    const url = await getWebhookUrl(c.env, getDb(c.env.DB));
    if (!url) throw new HTTPException(400, { message: "Webhook URL が設定されていません" });
    try {
      await sendDiscord(url, [
        { title: "UsageManagement テスト通知", description: "この通知が届いていれば設定は完了です。", color: 0x2357c6 },
      ]);
    } catch (e) {
      throw new HTTPException(502, { message: e instanceof Error ? e.message : "送信に失敗しました" });
    }
    return c.json({ ok: true });
  });

/** /api/services/:id/... に追加する自動取得関連のルート */
export const serviceCollectorRoute = new Hono<{ Bindings: Env }>()
  .get("/:id/collector", async (c) => {
    const id = parseId(c.req.param("id"));
    const db = getDb(c.env.DB);
    const s = await db.query.services.findFirst({ where: eq(services.id, id) });
    if (!s) return c.json({ error: "not found" }, 404);
    const cred = await db.query.credentials.findFirst({ where: eq(credentials.serviceId, id) });
    const body: CollectorConnection = {
      collectorId: s.collectorId,
      config: s.collectorConfig ? JSON.parse(s.collectorConfig) : {},
      secretHint: cred?.hint ?? null,
      hasSecrets: !!cred,
    };
    return c.json(body);
  })
  .put("/:id/collector", async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await parseBody(c, connectInput);
    const collector = getCollector(input.collectorId, { allowDemo: allowDemo(c.env) });
    if (!collector) throw new HTTPException(400, { message: "不明なコレクターです" });
    const db = getDb(c.env.DB);
    const s = await db.query.services.findFirst({ where: eq(services.id, id) });
    if (!s) return c.json({ error: "not found" }, 404);

    const sameCollector = s.collectorId === collector.meta.id;
    const existing =
      sameCollector ? await db.query.credentials.findFirst({ where: eq(credentials.serviceId, id) }) : undefined;
    const oldSecrets = existing ? await decryptJson(c.env.MASTER_KEY, existing).catch(() => ({})) : {};

    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const f of collector.meta.fields) {
      const v = (input.fields[f.key] ?? "").trim();
      if (f.secret) {
        const value = v || (oldSecrets as Record<string, string>)[f.key] || "";
        if (!value) throw new HTTPException(400, { message: `${f.label} を入力してください` });
        secrets[f.key] = value;
      } else {
        if (!v) throw new HTTPException(400, { message: `${f.label} を入力してください` });
        config[f.key] = v;
      }
    }
    const enc = await encryptJson(c.env.MASTER_KEY, secrets);
    const now = nowIso();

    // ひな形の指標を作成(既存の同じ key の指標はそのまま使い、collectorId だけ付ける)
    const existingMetrics = await db.select().from(metrics).where(eq(metrics.serviceId, id));
    const keys = new Set(existingMetrics.map((m) => m.key));
    const templateKeys = collector.meta.metrics.map((t) => t.key);
    const newMetrics = collector.meta.metrics
      .filter((t) => !keys.has(t.key))
      .map((t, i) => ({ ...t, serviceId: id, collectorId: collector.meta.id, limitValue: null, sortOrder: 100 + i }));

    await db.batch([
      db
        .update(services)
        .set({
          collectorId: collector.meta.id,
          collectorConfig: JSON.stringify(config),
          consecutiveFailures: 0,
          lastError: null,
          nextRunAt: null,
          updatedAt: now,
        })
        .where(eq(services.id, id)),
      db
        .insert(credentials)
        .values({ serviceId: id, ...enc, hint: secretHint(secrets), updatedAt: now })
        .onConflictDoUpdate({ target: credentials.serviceId, set: { ...enc, hint: secretHint(secrets), updatedAt: now } }),
      // 以前のコレクターの指標は手動入力扱いに戻す(履歴は残す)
      db.update(metrics).set({ collectorId: null }).where(eq(metrics.serviceId, id)),
      db
        .update(metrics)
        .set({ collectorId: collector.meta.id })
        .where(and(eq(metrics.serviceId, id), inArray(metrics.key, templateKeys))),
      ...newMetrics.map((m) => db.insert(metrics).values(m)),
    ]);
    await logEvent(db, "collector_connect", `service=${id} collector=${collector.meta.id}`);
    return c.json({ ok: true, createdMetrics: newMetrics.length });
  })
  .delete("/:id/collector", async (c) => {
    const id = parseId(c.req.param("id"));
    const db = getDb(c.env.DB);
    await db.batch([
      db
        .update(services)
        .set({ collectorId: null, collectorConfig: null, consecutiveFailures: 0, lastError: null, nextRunAt: null, updatedAt: nowIso() })
        .where(eq(services.id, id)),
      db.delete(credentials).where(eq(credentials.serviceId, id)),
      db.update(metrics).set({ collectorId: null }).where(eq(metrics.serviceId, id)),
    ]);
    await logEvent(db, "collector_disconnect", `service=${id}`);
    return c.body(null, 204);
  })
  /** 今すぐ取得(停止中・バックオフ中でも実行する) */
  .post("/:id/collect", async (c) => {
    const id = parseId(c.req.param("id"));
    const db = getDb(c.env.DB);
    const s = await db.query.services.findFirst({ where: eq(services.id, id) });
    if (!s) return c.json({ error: "not found" }, 404);
    if (!s.collectorId) throw new HTTPException(400, { message: "自動取得が設定されていません" });
    const settings = await getSettings(db);
    const result = await runService(c.env, db, s, {
      trigger: "manual",
      now: new Date(),
      fetch,
      autoPauseAfter: settings.autoPauseAfter,
    });
    c.executionCtx.waitUntil(evaluateAlerts(c.env, db, new Date()).catch((e) => console.error("alerts", e)));
    return c.json(result);
  })
  /** 当月の過去分(1 日〜昨日)を日別に補完 */
  .post("/:id/backfill", async (c) => {
    const id = parseId(c.req.param("id"));
    try {
      const db = getDb(c.env.DB);
      const r = await runBackfill(c.env, db, id, new Date());
      c.executionCtx.waitUntil(evaluateAlerts(c.env, db, new Date()).catch((e) => console.error("alerts", e)));
      return c.json(r);
    } catch (e) {
      if (e instanceof CollectorError) return c.json({ error: e.message }, e.kind === "config" ? 400 : 502);
      throw e;
    }
  })
  .get("/:id/runs", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await getDb(c.env.DB)
      .select()
      .from(collectorRuns)
      .where(eq(collectorRuns.serviceId, id))
      .orderBy(desc(collectorRuns.startedAt))
      .limit(20);
    return c.json(rows);
  })
  /** 定期取得の停止 / 期限付き一時停止 / 再開 */
  .put("/:id/polling", async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await parseBody(c, pollingInput);
    const db = getDb(c.env.DB);
    let set: Partial<typeof services.$inferInsert>;
    let event: string;
    if (!input.enabled) {
      set = { pollingEnabled: false, pausedUntil: null, pauseReason: input.reason || "手動で停止しました" };
      event = "service_stop";
    } else if (input.pausedUntil && new Date(input.pausedUntil) > new Date()) {
      set = { pollingEnabled: true, pausedUntil: new Date(input.pausedUntil).toISOString(), pauseReason: input.reason || null };
      event = "service_pause";
    } else {
      // 再開時は失敗カウントとバックオフもリセット
      set = { pollingEnabled: true, pausedUntil: null, pauseReason: null, consecutiveFailures: 0, nextRunAt: null };
      event = "service_resume";
    }
    const [row] = await db.update(services).set({ ...set, updatedAt: nowIso() }).where(eq(services.id, id)).returning();
    if (!row) return c.json({ error: "not found" }, 404);
    await logEvent(db, event, `service=${id}${set.pausedUntil ? ` until=${set.pausedUntil}` : ""}`);
    return c.json(row);
  });

export const metricPollingRoute = new Hono<{ Bindings: Env }>().put("/:id/polling", async (c) => {
  const id = parseId(c.req.param("id"));
  const { enabled } = await parseBody(c, z.object({ enabled: z.boolean() }));
  const db = getDb(c.env.DB);
  const [row] = await db
    .update(metrics)
    .set({ pollingEnabled: enabled, updatedAt: nowIso() })
    .where(eq(metrics.id, id))
    .returning();
  if (!row) return c.json({ error: "not found" }, 404);
  await logEvent(db, enabled ? "metric_resume" : "metric_stop", `metric=${id}`);
  return c.json(row);
});
