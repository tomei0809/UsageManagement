/** API でやり取りする型(Worker と Web で共用) */
import type { ResetType } from "./period";
import type { Forecast } from "./forecast";
import type { PollState } from "./schedule";
import type { UsageLevel } from "./usage";

export type MetricKind = "cumulative" | "gauge";
export type SnapshotSource = "api" | "manual" | "estimate";

export interface Service {
  id: number;
  name: string;
  category: string | null;
  url: string | null;
  notes: string | null;
  collectorId: string | null;
  collectorConfig: string | null;
  pollingEnabled: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  freeTierEndsAt: string | null;
  pauseOnFreeTierEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Metric {
  id: number;
  serviceId: number;
  key: string;
  label: string;
  unit: string;
  kind: MetricKind;
  limitValue: number | null;
  resetType: ResetType;
  resetAnchor: number | null;
  resetTimezone: string;
  cautionPct: number;
  warningPct: number;
  staleAfterHours: number;
  collectorId: string | null;
  pollingEnabled: boolean;
  pollIntervalHours: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: number;
  metricId: number;
  value: number;
  collectedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  source: SnapshotSource;
  collectorRunId: number | null;
  note: string | null;
}

/** ダッシュボード 1 指標分(計算済み) */
export interface MetricStatus {
  metric: Metric;
  /** 当期の最新記録(gauge / none は期間に関係なく最新) */
  latest: Snapshot | null;
  percent: number | null;
  remaining: number | null;
  level: UsageLevel;
  stale: boolean;
  periodStart: string | null;
  nextResetAt: string | null;
  /** 超過予測(実測ではない)。データ不足・上限なしは null */
  forecast: Forecast | null;
}

export interface ServiceStatus {
  service: Service;
  pollState: PollState;
  metrics: MetricStatus[];
}

export interface DashboardResponse {
  generatedAt: string;
  settings: AppSettings;
  services: ServiceStatus[];
}

export type ServiceInput = Pick<Service, "name" | "category" | "url" | "notes" | "freeTierEndsAt" | "pauseOnFreeTierEnd">;

export type MetricInput = Pick<
  Metric,
  | "key"
  | "label"
  | "unit"
  | "kind"
  | "limitValue"
  | "resetType"
  | "resetAnchor"
  | "resetTimezone"
  | "cautionPct"
  | "warningPct"
  | "staleAfterHours"
  | "sortOrder"
>;

export interface SnapshotInput {
  value: number;
  collectedAt?: string;
  note?: string | null;
}

export type SeriesResponse =
  | { granularity: "day"; timezone: string; daily: import("./series").DailyPoint[] }
  | { granularity: "month"; timezone: string; monthly: import("./series").MonthlyPoint[] };

export interface AppSettings {
  /** アプリ全体の定期取得 */
  schedulerEnabled: boolean;
  /** 連続この回数失敗したらサービスの定期取得を自動停止(0 = 無効) */
  autoPauseAfter: number;
  /** Discord 通知(全体) */
  notificationsEnabled: boolean;
  /** Webhook URL のヒント(末尾のみ)。未設定は null。値そのものは返さない */
  webhookHint: string | null;
}

export interface CollectorRun {
  id: number;
  serviceId: number | null;
  collectorId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed" | "skipped";
  errorMessage: string | null;
}

/** 接続設定の取得結果(秘密情報の値は返さない) */
export interface CollectorConnection {
  collectorId: string | null;
  config: Record<string, string>;
  secretHint: string | null;
  hasSecrets: boolean;
}

export interface PollingInput {
  enabled: boolean;
  /** 期限付き一時停止(ISO)。null で解除 */
  pausedUntil?: string | null;
  reason?: string | null;
}
