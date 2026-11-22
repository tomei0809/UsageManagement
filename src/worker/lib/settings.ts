import { eq } from "drizzle-orm";
import { appEvents, appSettings } from "../db/schema";
import { DEFAULT_AUTO_PAUSE_AFTER } from "../../shared/schedule";
import type { AppSettings } from "../../shared/types";
import type { Env } from "../env";
import { decryptJson, encryptJson } from "./crypto";
import { nowIso, type Db } from "./db";

const WEBHOOK_KEY = "discord_webhook";

export async function getSettings(db: Db): Promise<AppSettings> {
  const rows = await db.select().from(appSettings);
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const webhook = m.get(WEBHOOK_KEY);
  return {
    schedulerEnabled: (m.get("scheduler_enabled") ?? "true") === "true",
    autoPauseAfter: Number(m.get("auto_pause_after") ?? DEFAULT_AUTO_PAUSE_AFTER),
    notificationsEnabled: (m.get("notifications_enabled") ?? "true") === "true",
    webhookHint: webhook ? ((JSON.parse(webhook) as { hint?: string }).hint ?? "設定済み") : null,
  };
}

async function put(db: Db, key: string, value: string) {
  const updatedAt = nowIso();
  await db.insert(appSettings).values({ key, value, updatedAt }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } });
}

export async function saveSettings(db: Db, s: Pick<AppSettings, "schedulerEnabled" | "autoPauseAfter" | "notificationsEnabled">) {
  await put(db, "scheduler_enabled", String(s.schedulerEnabled));
  await put(db, "auto_pause_after", String(s.autoPauseAfter));
  await put(db, "notifications_enabled", String(s.notificationsEnabled));
}

/** Discord Webhook URL は秘密情報として暗号化して保存(URL を知っていれば誰でも投稿できるため) */
export async function setWebhookUrl(env: Env, db: Db, url: string | null) {
  if (!url) {
    await db.delete(appSettings).where(eq(appSettings.key, WEBHOOK_KEY));
    return;
  }
  const enc = await encryptJson(env.MASTER_KEY, { url });
  await put(db, WEBHOOK_KEY, JSON.stringify({ ...enc, hint: `…${url.slice(-6)}` }));
}

export async function getWebhookUrl(env: Env, db: Db): Promise<string | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, WEBHOOK_KEY) });
  if (!row) return null;
  try {
    return (await decryptJson(env.MASTER_KEY, JSON.parse(row.value) as { ciphertext: string; iv: string })).url ?? null;
  } catch {
    return null;
  }
}

export async function logEvent(db: Db, type: string, detail: string) {
  await db.insert(appEvents).values({ type, detail });
}
