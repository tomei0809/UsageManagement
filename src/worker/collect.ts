/**
 * 自動取得の実行(Cron と「今すぐ取得」の共通処理)。
 * 判定ロジックは shared/schedule.ts(純粋関数)、ここは DB とコレクター呼び出しの配線。
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { currentPeriod } from "../shared/period";
import { backoffUntil, shouldAutoPause, shouldRunScheduled } from "../shared/schedule";
import { collectorRuns, credentials, metrics, services, snapshots } from "./db/schema";
import { allowDemo, type Env } from "./env";
import { getCollector } from "./collectors/registry";
import { CollectorError, type Reading } from "./collectors/types";
import { decryptJson } from "./lib/crypto";
import { getDb, type Db } from "./lib/db";
import { getSettings, logEvent } from "./lib/settings";
import { freeTierEndInstant, notify } from "./notify";

type ServiceRow = typeof services.$inferSelect;

export interface RunResult {
  runId: number;
  status: "success" | "failed" | "skipped";
  error: string | null;
  saved: number;
}

export interface RunOptions {
  trigger: "cron" | "manual";
  now: Date;
  fetch: typeof fetch;
  autoPauseAfter: number;
}

export async function runService(env: Env, db: Db, service: ServiceRow, opts: RunOptions): Promise<RunResult> {
  const { now } = opts;
  const collector = service.collectorId ? getCollector(service.collectorId, { allowDemo: allowDemo(env) }) : undefined;
  const [run] = await db
    .insert(collectorRuns)
    .values({ serviceId: service.id, collectorId: service.collectorId ?? "-", status: "running", startedAt: now.toISOString() })
    .returning({ id: collectorRuns.id });
  const runId = run!.id;

  try {
    if (!collector) throw new CollectorError("config", `コレクター「${service.collectorId}」は利用できません`);
    const fields = await loadFields(env, db, service);
    const readings = await collector.collect({ fields, now, fetch: opts.fetch });
    const saved = await saveReadings(db, service.id, readings, now, runId);

    const finishedAt = new Date().toISOString();
    await db.batch([
      db.update(collectorRuns).set({ status: "success", finishedAt }).where(eq(collectorRuns.id, runId)),
      db
        .update(services)
        .set({
          consecutiveFailures: 0,
          lastRunAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          lastError: null,
          nextRunAt: null,
          // 期限切れの一時停止は成功時に片付ける
          ...(service.pausedUntil && new Date(service.pausedUntil) <= now ? { pausedUntil: null, pauseReason: null } : {}),
        })
        .where(eq(services.id, service.id)),
    ]);
    return { runId, status: "success", error: null, saved };
  } catch (e) {
    const message = e instanceof CollectorError ? e.message : "内部エラーが発生しました(ログを確認してください)";
    if (!(e instanceof CollectorError)) console.error("collector failed", service.collectorId, e);

    const failures = service.consecutiveFailures + 1;
    const autoPause = opts.trigger === "cron" && shouldAutoPause(failures, opts.autoPauseAfter);
    await db.batch([
      db
        .update(collectorRuns)
        .set({ status: "failed", finishedAt: new Date().toISOString(), errorMessage: message })
        .where(eq(collectorRuns.id, runId)),
      db
        .update(services)
        .set({
          consecutiveFailures: failures,
          lastRunAt: now.toISOString(),
          lastError: message,
          nextRunAt: backoffUntil(failures, now)?.toISOString() ?? null,
          ...(autoPause
            ? { pollingEnabled: false, pauseReason: `連続 ${failures} 回失敗したため自動停止しました` }
            : {}),
        })
        .where(eq(services.id, service.id)),
    ]);
    if (autoPause) {
      await logEvent(db, "auto_pause", `service=${service.id} failures=${failures}: ${message}`);
      await notify(env, db, [
        {
          title: `自動取得を停止しました: ${service.name}`,
          description: `連続 ${failures} 回失敗したため、定期取得を自動停止しました。\n最後のエラー: ${message}\n原因を直したら、サービス詳細の「再開」を押してください。`,
          color: 0xc42b2b,
        },
      ]).catch((e) => console.error("notify failed", e));
    }
    return { runId, status: "failed", error: message, saved: 0 };
  }
}

async function loadFields(env: Env, db: Db, service: ServiceRow): Promise<Record<string, string>> {
  const config = service.collectorConfig ? (JSON.parse(service.collectorConfig) as Record<string, string>) : {};
  const cred = await db.query.credentials.findFirst({ where: eq(credentials.serviceId, service.id) });
  if (!cred) return config;
  try {
    return { ...config, ...(await decryptJson(env.MASTER_KEY, cred)) };
  } catch {
    throw new CollectorError("config", "認証情報を復号できません。MASTER_KEY が変わった場合は接続設定を保存し直してください");
  }
}

/** 取得値を指標(key で対応)に保存。停止中の指標には保存しない */
async function saveReadings(db: Db, serviceId: number, readings: Reading[], now: Date, runId: number) {
  const ms = await db.select().from(metrics).where(eq(metrics.serviceId, serviceId));
  const byKey = new Map(ms.map((m) => [m.key, m]));
  const stmts = [];
  for (const r of readings) {
    const m = byKey.get(r.metricKey);
    if (!m || !m.pollingEnabled) continue;
    const period = currentPeriod(m, now);
    stmts.push(
      db.insert(snapshots).values({
        metricId: m.id,
        value: r.value,
        collectedAt: now.toISOString(),
        periodStart: period?.start.toISOString() ?? null,
        periodEnd: period?.end.toISOString() ?? null,
        source: "api",
        collectorRunId: runId,
      }),
    );
    if (r.limitValue !== undefined && r.limitValue !== m.limitValue) {
      stmts.push(db.update(metrics).set({ limitValue: r.limitValue, updatedAt: now.toISOString() }).where(eq(metrics.id, m.id)));
    }
  }
  if (stmts.length) await db.batch(stmts as [(typeof stmts)[number], ...typeof stmts]);
  return stmts.length;
}

/** Cron から呼ばれる。停止の 3 階層・バックオフを判定し、対象サービスだけを順に取得する */
export async function runScheduled(env: Env, now: Date, f: typeof fetch = fetch) {
  const db = getDb(env.DB);
  const settings = await getSettings(db);
  if (!settings.schedulerEnabled) return { ran: 0, skipped: "global" as const };

  const rows = await db.select().from(services).where(isNotNull(services.collectorId));
  const enabledMetricServices = new Set(
    (await db.select({ serviceId: metrics.serviceId }).from(metrics).where(and(eq(metrics.pollingEnabled, true), isNotNull(metrics.collectorId)))).map(
      (r) => r.serviceId,
    ),
  );
  let ran = 0;
  for (const s of rows) {
    // 無料期間が終わったら自動取得を止める(設定したサービスのみ。既存の停止機能を使う)
    if (s.pauseOnFreeTierEnd && s.freeTierEndsAt && s.pollingEnabled && now >= freeTierEndInstant(s.freeTierEndsAt)) {
      const reason = "無料期間が終了したため自動取得を停止しました";
      // pauseOnFreeTierEnd は 1 回使ったら外す(ユーザーが「再開」したら、次の定期実行で再び止めないため)
      await db
        .update(services)
        .set({ pollingEnabled: false, pauseReason: reason, pauseOnFreeTierEnd: false, updatedAt: now.toISOString() })
        .where(eq(services.id, s.id));
      await logEvent(db, "free_tier_pause", `service=${s.id}`);
      await notify(env, db, [
        { title: `${reason}: ${s.name}`, description: `無料期間の終了日 ${s.freeTierEndsAt}。再開する場合はサービス詳細の「再開」を押してください。`, color: 0x5b6470 },
      ]).catch((e) => console.error("notify failed", e));
      continue;
    }
    if (!shouldRunScheduled(s, settings.schedulerEnabled, now)) continue;
    // 指標がすべて停止中なら API を呼ばない
    if (!enabledMetricServices.has(s.id)) continue;
    await runService(env, db, s, { trigger: "cron", now, fetch: f, autoPauseAfter: settings.autoPauseAfter });
    ran++;
  }
  return { ran, skipped: null };
}
