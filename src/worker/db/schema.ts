import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** 管理対象サービス(例: GitHub Actions, Supabase) */
export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category"),
  url: text("url"),
  notes: text("notes"),
  // 自動取得(NULL = 手動入力のみ)
  collectorId: text("collector_id"),
  /** 秘密でない接続設定(JSON。例: {"username":"octocat"})。秘密情報は credentials に暗号化して保存 */
  collectorConfig: text("collector_config"),
  // 定期チェックの停止: polling_enabled=false は無期限停止、paused_until は期限付き一時停止
  pollingEnabled: integer("polling_enabled", { mode: "boolean" }).notNull().default(true),
  pausedUntil: text("paused_until"),
  pauseReason: text("pause_reason"),
  // 取得状況(バックオフ・自動停止の判定に使う)
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastRunAt: text("last_run_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  /** 失敗後のバックオフ: この時刻まで定期取得を見送る */
  nextRunAt: text("next_run_at"),
  /** 無料期間の終了日(YYYY-MM-DD。この日まで無料)。任意 */
  freeTierEndsAt: text("free_tier_ends_at"),
  /** 無料期間が終わったら自動取得を止める */
  pauseOnFreeTierEnd: integer("pause_on_free_tier_end", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * 送信済みの通知(重複防止)。subject は "m:<metricId>" / "s:<serviceId>"。
 * 同じ kind・subject・period_key の行は 1 つだけで、level は通知済みの最高レベル。
 */
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    periodKey: text("period_key").notNull(),
    level: text("level").notNull(),
    notifiedAt: text("notified_at").notNull().default(now),
  },
  (t) => [uniqueIndex("alerts_unique").on(t.kind, t.subject, t.periodKey)],
);

/** コレクターの秘密情報(API トークン等)。AES-GCM で暗号化し、鍵は Workers Secret の MASTER_KEY */
export const credentials = sqliteTable("credentials", {
  serviceId: integer("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  /** 画面表示用のヒント(例: "token: …a1b2")。値そのものは返さない */
  hint: text("hint"),
  updatedAt: text("updated_at").notNull().default(now),
});

/** サービスの各指標(例: Supabase の DB 容量 / Egress)。上限・単位・リセット方式はここに持つ */
export const metrics = sqliteTable(
  "metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    unit: text("unit").notNull(),
    /** cumulative: 期間内に積み上がる / gauge: その時点の量 */
    kind: text("kind", { enum: ["cumulative", "gauge"] }).notNull().default("cumulative"),
    /** NULL = 上限なし(使用率は計算しない) */
    limitValue: real("limit_value"),
    resetType: text("reset_type", { enum: ["monthly", "daily", "weekly", "rolling", "none"] })
      .notNull()
      .default("monthly"),
    /** monthly: 日(1-31) / weekly: 曜日(0=日) / rolling: 時間数 */
    resetAnchor: integer("reset_anchor"),
    resetTimezone: text("reset_timezone").notNull().default("UTC"),
    cautionPct: real("caution_pct").notNull().default(80),
    warningPct: real("warning_pct").notNull().default(95),
    staleAfterHours: integer("stale_after_hours").notNull().default(48),
    /** NULL = 手動入力のみ */
    collectorId: text("collector_id"),
    pollingEnabled: integer("polling_enabled", { mode: "boolean" }).notNull().default(true),
    pollIntervalHours: integer("poll_interval_hours"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("metrics_service_key").on(t.serviceId, t.key)],
);

/** 使用量の記録(履歴)。手動入力・API 取得・推定値を source で区別 */
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    metricId: integer("metric_id")
      .notNull()
      .references(() => metrics.id, { onDelete: "cascade" }),
    value: real("value").notNull(),
    collectedAt: text("collected_at").notNull().default(now),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    source: text("source", { enum: ["api", "manual", "estimate"] }).notNull(),
    collectorRunId: integer("collector_run_id"),
    note: text("note"),
  },
  (t) => [index("snapshots_metric_time").on(t.metricId, t.collectedAt)],
);

/** 自動取得の実行記録(第3段階) */
export const collectorRuns = sqliteTable(
  "collector_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serviceId: integer("service_id").references(() => services.id, { onDelete: "cascade" }),
    collectorId: text("collector_id").notNull(),
    startedAt: text("started_at").notNull().default(now),
    finishedAt: text("finished_at"),
    status: text("status", { enum: ["running", "success", "partial", "failed", "skipped"] }).notNull(),
    errorMessage: text("error_message"),
  },
  (t) => [index("collector_runs_service_time").on(t.serviceId, t.startedAt)],
);

/** アプリ全体の設定(scheduler_enabled など) */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/** 操作ログ(停止/再開など) */
export const appEvents = sqliteTable("app_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull().default(now),
  type: text("type").notNull(),
  detail: text("detail"),
});

