/**
 * 定期取得の可否判定(純粋関数)。停止は 3 階層:
 *   アプリ全体(app_settings.scheduler_enabled) > サービス(polling_enabled / paused_until) > 指標(polling_enabled)
 * 加えて、失敗時のバックオフ(next_run_at)と、連続失敗での自動停止がある。
 */

export const CRON_INTERVAL_HOURS = 6;
export const DEFAULT_AUTO_PAUSE_AFTER = 5;

export type PollState =
  | "manual" // コレクター未設定(手動入力のみ)
  | "active" // 次回の定期実行で取得する
  | "backoff" // 失敗したため次回を見送り中(next_run_at まで)
  | "paused" // 期限付き一時停止中
  | "stopped" // 無期限停止(手動 or 自動停止)
  | "global-stopped"; // アプリ全体で停止中

export interface PollingFields {
  collectorId: string | null;
  pollingEnabled: boolean;
  pausedUntil: string | null;
  nextRunAt: string | null;
}

export function pollState(s: PollingFields, schedulerEnabled: boolean, now: Date): PollState {
  if (!s.collectorId) return "manual";
  if (!schedulerEnabled) return "global-stopped";
  if (!s.pollingEnabled) return "stopped";
  if (s.pausedUntil && new Date(s.pausedUntil) > now) return "paused";
  if (s.nextRunAt && new Date(s.nextRunAt) > now) return "backoff";
  return "active";
}

export const shouldRunScheduled = (s: PollingFields, schedulerEnabled: boolean, now: Date) =>
  pollState(s, schedulerEnabled, now) === "active";

/**
 * n 回連続失敗した後、次に試すまでの時間。6h, 12h, 24h, 48h(上限)。
 * Cron は 6 時間ごとなので、境界で取りこぼさないよう 10 分早めに解除する。
 */
export function backoffUntil(consecutiveFailures: number, now: Date): Date | null {
  if (consecutiveFailures <= 1) return null; // 1 回目の失敗は次の定期実行でそのまま再試行
  const hours = Math.min(CRON_INTERVAL_HOURS * 2 ** (consecutiveFailures - 1), 48);
  return new Date(now.getTime() + hours * 3_600_000 - 10 * 60_000);
}

export function shouldAutoPause(consecutiveFailures: number, autoPauseAfter: number): boolean {
  return autoPauseAfter > 0 && consecutiveFailures >= autoPauseAfter;
}

export const POLL_STATE_LABEL: Record<PollState, string> = {
  manual: "手動入力",
  active: "自動取得中",
  backoff: "再試行待ち",
  paused: "一時停止中",
  stopped: "停止中",
  "global-stopped": "全体停止中",
};
