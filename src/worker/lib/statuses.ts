import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { baselineSince } from "../../shared/forecast";
import { pollState } from "../../shared/schedule";
import { buildMetricStatus, latestSince } from "../../shared/status";
import type { AppSettings, DashboardResponse, Snapshot } from "../../shared/types";
import { metrics, services, snapshots } from "../db/schema";
import type { Db } from "./db";

type Batchable = Parameters<Db["batch"]>[0][number];
async function batchAll<T>(db: Db, queries: Batchable[]): Promise<T[]> {
  if (queries.length === 0) return [];
  return (await db.batch(queries as [Batchable, ...Batchable[]])) as T[];
}

/**
 * 全サービス・全指標の状態(使用率・鮮度・予測)を計算する。ダッシュボードと通知で共用。
 * 指標ごとに「現在値」と「予測の比較用の記録」を 1 クエリずつ読む(索引 metric_id, collected_at を使う)。
 */
export async function loadDashboard(db: Db, settings: AppSettings, now: Date): Promise<DashboardResponse> {
  const [svcRows, metricRows] = await db.batch([
    db.select().from(services).orderBy(asc(services.name)),
    db.select().from(metrics).orderBy(asc(metrics.sortOrder), asc(metrics.id)),
  ]);

  const latest = await batchAll<Snapshot[]>(
    db,
    metricRows.map((m) => {
      const since = latestSince(m, now);
      const where = since ? and(eq(snapshots.metricId, m.id), gte(snapshots.collectedAt, since)) : eq(snapshots.metricId, m.id);
      return db.select().from(snapshots).where(where).orderBy(desc(snapshots.collectedAt)).limit(1);
    }),
  );

  // 予測の比較用:最新の記録より前で、直近 7 日(累積型は当期内)の最も古い記録
  const needBaseline = metricRows
    .map((m, i) => ({ m, l: latest[i]?.[0] }))
    .filter((x): x is { m: (typeof metricRows)[number]; l: Snapshot } => !!x.l && x.m.limitValue !== null);
  const baselines = await batchAll<Snapshot[]>(
    db,
    needBaseline.map(({ m, l }) =>
      db
        .select()
        .from(snapshots)
        .where(
          and(
            eq(snapshots.metricId, m.id),
            gte(snapshots.collectedAt, baselineSince(m, new Date(l.collectedAt))),
            lt(snapshots.collectedAt, l.collectedAt),
          ),
        )
        .orderBy(asc(snapshots.collectedAt))
        .limit(1),
    ),
  );
  const baselineById = new Map(needBaseline.map((x, i) => [x.m.id, baselines[i]?.[0] ?? null]));

  const byService = new Map<number, DashboardResponse["services"][number]["metrics"]>();
  metricRows.forEach((m, i) => {
    const list = byService.get(m.serviceId) ?? [];
    list.push(buildMetricStatus(m, latest[i]?.[0] ?? null, now, baselineById.get(m.id) ?? null));
    byService.set(m.serviceId, list);
  });

  return {
    generatedAt: now.toISOString(),
    settings,
    services: svcRows.map((s) => ({
      service: s,
      pollState: pollState(s, settings.schedulerEnabled, now),
      metrics: byService.get(s.id) ?? [],
    })),
  };
}
