/**
 * 過去分の補完(当月 1 日〜昨日)。
 * - 各日の終わり(UTC 23:59:59.999)時点の値を source=api, note=BACKFILL_NOTE で保存する
 * - 再実行時は、以前の補完記録だけを削除して入れ直す(冪等)
 * - 実際に記録がある日(手動入力・定期取得)は上書きしない
 */
import { and, eq, gte, inArray, ne, or, isNull } from "drizzle-orm";
import { BACKFILL_NOTE } from "../shared/collectors";
import { currentPeriod } from "../shared/period";
import { credentials, metrics, services, snapshots } from "./db/schema";
import { allowDemo, type Env } from "./env";
import { getCollector } from "./collectors/registry";
import { CollectorError, type DailyReadings } from "./collectors/types";
import { decryptJson } from "./lib/crypto";
import type { Db } from "./lib/db";
import { logEvent } from "./lib/settings";

export interface PlannedSnapshot {
  metricId: number;
  value: number;
  collectedAt: string;
}

/**
 * 保存する記録を決める(純粋関数)。
 * @param metricsByKey 自動取得がオンの指標(key → id)
 * @param realDaysByMetric 補完以外の記録がある日(metricId → YYYY-MM-DD の集合)
 */
export function planBackfill(
  daily: DailyReadings[],
  metricsByKey: Map<string, number>,
  realDaysByMetric: Map<number, Set<string>>,
): PlannedSnapshot[] {
  const out: PlannedSnapshot[] = [];
  for (const d of daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
    for (const r of d.readings) {
      const metricId = metricsByKey.get(r.metricKey);
      if (metricId === undefined) continue;
      if (realDaysByMetric.get(metricId)?.has(d.date)) continue;
      out.push({ metricId, value: r.value, collectedAt: `${d.date}T23:59:59.999Z` });
    }
  }
  return out;
}

export async function runBackfill(env: Env, db: Db, serviceId: number, now: Date) {
  const service = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!service?.collectorId) throw new CollectorError("config", "自動取得が設定されていません");
  const collector = getCollector(service.collectorId, { allowDemo: allowDemo(env) });
  if (!collector?.backfill) throw new CollectorError("config", "この取得方法は過去分の補完に対応していません");

  const config = service.collectorConfig ? (JSON.parse(service.collectorConfig) as Record<string, string>) : {};
  const cred = await db.query.credentials.findFirst({ where: eq(credentials.serviceId, serviceId) });
  let fields = config;
  if (cred) {
    try {
      fields = { ...config, ...(await decryptJson(env.MASTER_KEY, cred)) };
    } catch {
      throw new CollectorError("config", "認証情報を復号できません。接続設定を保存し直してください");
    }
  }

  const daily = await collector.backfill({ fields, now, fetch });

  const ms = await db
    .select()
    .from(metrics)
    .where(and(eq(metrics.serviceId, serviceId), eq(metrics.pollingEnabled, true)));
  const metricIds = ms.map((m) => m.id);
  if (metricIds.length === 0) return { saved: 0, days: daily.length };

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const real = await db
    .select({ metricId: snapshots.metricId, collectedAt: snapshots.collectedAt })
    .from(snapshots)
    .where(
      and(
        inArray(snapshots.metricId, metricIds),
        gte(snapshots.collectedAt, monthStart),
        or(isNull(snapshots.note), ne(snapshots.note, BACKFILL_NOTE)),
      ),
    );
  const realDays = new Map<number, Set<string>>();
  for (const r of real) {
    const set = realDays.get(r.metricId) ?? new Set<string>();
    set.add(r.collectedAt.slice(0, 10)); // collectedAt は UTC の ISO 文字列
    realDays.set(r.metricId, set);
  }

  const plan = planBackfill(daily, new Map(ms.map((m) => [m.key, m.id])), realDays);
  const byId = new Map(ms.map((m) => [m.id, m]));
  await db.batch([
    db
      .delete(snapshots)
      .where(
        and(inArray(snapshots.metricId, metricIds), eq(snapshots.note, BACKFILL_NOTE), gte(snapshots.collectedAt, monthStart)),
      ),
    ...plan.map((p) => {
      const period = currentPeriod(byId.get(p.metricId)!, new Date(p.collectedAt));
      return db.insert(snapshots).values({
        ...p,
        periodStart: period?.start.toISOString() ?? null,
        periodEnd: period?.end.toISOString() ?? null,
        source: "api",
        note: BACKFILL_NOTE,
      });
    }),
  ]);
  await logEvent(db, "backfill", `service=${serviceId} days=${daily.length} saved=${plan.length}`);
  return { saved: plan.length, days: daily.length };
}
