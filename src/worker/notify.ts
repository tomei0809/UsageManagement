/**
 * Discord 通知。「レベルが上がった時だけ」送る(同じ期間内で同じ通知は繰り返さない)。
 *   - 使用率レベル:注意 → 警告 → 上限到達 と上がった時。値が正常(ok)に戻ったら記録を消し、次に上がったら再通知
 *   - 超過見込み:累積型は 1 期間に 1 回。その時点の量(gauge)は見込みが消えたら記録を消す
 *   - 無料期間の終了:30 日前・7 日前・終了時に 1 回ずつ
 *   - 自動停止(連続失敗 / 無料期間終了):発生時に 1 回
 * 判定は decideAlerts(純粋関数)、送信と記録は evaluateAlerts。
 */
import { and, eq, inArray } from "drizzle-orm";
import { formatDateIn, formatPercent, formatValue } from "../shared/format";
import type { DashboardResponse, MetricStatus, Service } from "../shared/types";
import { alerts } from "./db/schema";
import type { Env } from "./env";
import type { Db } from "./lib/db";
import { getSettings, getWebhookUrl } from "./lib/settings";
import { loadDashboard } from "./lib/statuses";

const DAY = 86_400_000;
const LEVEL_RANK: Record<string, number> = { ok: 0, unknown: 0, caution: 1, warning: 2, limit: 3 };
const LEVEL_LABEL: Record<string, string> = { caution: "注意", warning: "警告", limit: "上限到達" };
const LEVEL_COLOR: Record<string, number> = { caution: 0xb7791f, warning: 0xd0561b, limit: 0xc42b2b };
const FREE_TIER_STEPS = [30, 7, 0];

export interface Notice {
  title: string;
  description: string;
  color: number;
}

export interface AlertRow {
  kind: string;
  subject: string;
  periodKey: string;
  level: string;
}

export interface AlertDecision {
  notices: Notice[];
  upserts: AlertRow[];
  deletes: AlertRow[];
}

/** 無料期間の終了時刻(終了日の翌日 0:00 UTC。終了日までは無料とみなす) */
export function freeTierEndInstant(date: string): Date {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY);
}

/** 残り日数から通知段階(30 / 7 / 0)を決める。30 日より先は null */
export function freeTierStep(endsAt: string, now: Date): number | null {
  const daysLeft = Math.ceil((freeTierEndInstant(endsAt).getTime() - now.getTime()) / DAY);
  if (daysLeft <= 0) return 0;
  const steps = FREE_TIER_STEPS.filter((s) => s > 0 && daysLeft <= s);
  return steps.length ? Math.min(...steps) : null;
}

export function decideAlerts(dash: DashboardResponse, existing: AlertRow[], now: Date, timeZone: string): AlertDecision {
  const key = (r: Pick<AlertRow, "kind" | "subject" | "periodKey">) => `${r.kind}|${r.subject}|${r.periodKey}`;
  const prev = new Map(existing.map((r) => [key(r), r]));
  const out: AlertDecision = { notices: [], upserts: [], deletes: [] };
  const date = (iso: string) => formatDateIn(iso, timeZone);

  for (const { service, metrics } of dash.services) {
    for (const s of metrics) {
      const subject = `m:${s.metric.id}`;
      const periodKey = s.periodStart ?? "none";
      const name = `${service.name} / ${s.metric.label}`;

      // 使用率レベル
      const lvKey = { kind: "level", subject, periodKey };
      const lvPrev = prev.get(key(lvKey));
      const rank = LEVEL_RANK[s.level] ?? 0;
      if (rank === 0) {
        if (lvPrev) out.deletes.push(lvPrev);
      } else if (rank > (LEVEL_RANK[lvPrev?.level ?? "ok"] ?? 0)) {
        out.upserts.push({ ...lvKey, level: s.level });
        out.notices.push({ title: `${LEVEL_LABEL[s.level]}: ${name}`, description: usageText(s, date), color: LEVEL_COLOR[s.level]! });
      }

      // 超過見込み(上限到達済みなら不要)
      const fcKey = { kind: "forecast", subject, periodKey };
      const fcPrev = prev.get(key(fcKey));
      const f = s.forecast;
      if (f?.willExceed && s.level !== "limit") {
        if (!fcPrev) {
          out.upserts.push({ ...fcKey, level: "exceed" });
          out.notices.push({
            title: `超過見込み: ${name}`,
            description: [
              f.projected !== null
                ? `期末の予測 ${formatValue(f.projected, s.metric.unit)} / 上限 ${formatValue(s.metric.limitValue, s.metric.unit)}(${formatPercent(f.projectedPercent)})`
                : `増加ペース ${formatValue(f.pacePerDay, s.metric.unit)}/日`,
              f.exceedAt ? `${date(f.exceedAt)}ごろ上限に達する見込みです(${f.method === "7d" ? "直近7日" : "期間開始から"}のペース)。` : "",
              `現在 ${formatValue(s.latest?.value, s.metric.unit)}(${formatPercent(s.percent)})※予測値は実測ではありません`,
            ]
              .filter(Boolean)
              .join("\n"),
            color: LEVEL_COLOR.warning!,
          });
        }
      } else if (fcPrev && s.metric.kind === "gauge") {
        out.deletes.push(fcPrev);
      }
    }

    // 無料期間の終了
    if (service.freeTierEndsAt) {
      const step = freeTierStep(service.freeTierEndsAt, now);
      const ftKey = { kind: "free_tier", subject: `s:${service.id}`, periodKey: service.freeTierEndsAt };
      const ftPrev = prev.get(key(ftKey));
      if (step !== null && (ftPrev === undefined || Number(ftPrev.level) > step)) {
        out.upserts.push({ ...ftKey, level: String(step) });
        out.notices.push(freeTierNotice(service, step, date));
      }
    }
  }
  return out;
}

function usageText(s: MetricStatus, date: (iso: string) => string): string {
  const lines = [
    `使用率 ${formatPercent(s.percent)}(${formatValue(s.latest?.value, s.metric.unit)} / ${formatValue(s.metric.limitValue, s.metric.unit)})`,
    `残り ${formatValue(s.remaining, s.metric.unit)}`,
  ];
  if (s.nextResetAt) lines.push(`次回リセット ${date(s.nextResetAt)}`);
  return lines.join("\n");
}

function freeTierNotice(service: Service, step: number, date: (iso: string) => string): Notice {
  const end = date(`${service.freeTierEndsAt}T12:00:00Z`);
  if (step === 0) {
    return {
      title: `無料期間が終了しました: ${service.name}`,
      description: `終了日 ${end}。上限を「無料枠」から予算に変える、料金の指標を追加する、使わないなら自動取得を止める、などを検討してください。`,
      color: LEVEL_COLOR.limit!,
    };
  }
  return {
    title: `無料期間の終了まであと ${step} 日以内: ${service.name}`,
    description: `終了日 ${end}${service.pauseOnFreeTierEnd ? "。終了後は自動取得を自動で停止します。" : "。"}`,
    color: step <= 7 ? LEVEL_COLOR.warning! : LEVEL_COLOR.caution!,
  };
}

/** Discord Webhook へ送信(1 メッセージに最大 10 件の embed) */
export async function sendDiscord(webhookUrl: string, notices: Notice[], f: typeof fetch = fetch): Promise<void> {
  for (let i = 0; i < notices.length; i += 10) {
    const res = await f(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "UsageManagement",
        allowed_mentions: { parse: [] },
        embeds: notices.slice(i, i + 10).map((n) => ({
          title: n.title.slice(0, 256),
          description: n.description.slice(0, 4000),
          color: n.color,
          timestamp: new Date().toISOString(),
        })),
      }),
    });
    if (!res.ok) throw new Error(`Discord への送信に失敗しました(HTTP ${res.status})`);
  }
}

/** 通知が有効で Webhook が設定されていれば送る。送れたら true */
export async function notify(env: Env, db: Db, notices: Notice[]): Promise<boolean> {
  if (notices.length === 0) return false;
  const settings = await getSettings(db);
  if (!settings.notificationsEnabled) return false;
  const url = await getWebhookUrl(env, db);
  if (!url) return false;
  await sendDiscord(url, notices);
  return true;
}

/**
 * 全指標を評価して通知する(Cron の最後、手動入力・今すぐ取得の後に呼ぶ)。
 * 通知がオフ・Webhook 未設定のときは、あとでまとめて大量に届かないよう記録だけ更新する。
 */
export async function evaluateAlerts(env: Env, db: Db, now: Date) {
  const settings = await getSettings(db);
  const dash = await loadDashboard(db, settings, now);
  const existing = await db.select().from(alerts);
  const d = decideAlerts(dash, existing, now, env.TIMEZONE || "Asia/Tokyo");

  if (d.notices.length) {
    try {
      await notify(env, db, d.notices);
    } catch (e) {
      // 送信失敗時は記録を更新しない(次回もう一度送る)
      console.error("notify failed", e instanceof Error ? e.message : e);
      return { sent: 0, error: true };
    }
  }
  const stmts = [
    ...d.deletes.map((r) =>
      db.delete(alerts).where(and(eq(alerts.kind, r.kind), eq(alerts.subject, r.subject), eq(alerts.periodKey, r.periodKey))),
    ),
    ...d.upserts.map((r) =>
      db
        .insert(alerts)
        .values({ ...r, notifiedAt: now.toISOString() })
        .onConflictDoUpdate({
          target: [alerts.kind, alerts.subject, alerts.periodKey],
          set: { level: r.level, notifiedAt: now.toISOString() },
        }),
    ),
  ];
  if (stmts.length) await db.batch(stmts as [(typeof stmts)[number], ...typeof stmts]);
  // 古い期間の使用率・予測の記録は 100 日で掃除(無料期間の記録は消すと再通知されるので残す)
  const old = existing
    .filter((r) => r.kind !== "free_tier" && now.getTime() - new Date(r.periodKey).getTime() > 100 * DAY)
    .map((r) => r.periodKey);
  if (old.length) await db.delete(alerts).where(and(inArray(alerts.periodKey, old), inArray(alerts.kind, ["level", "forecast"])));
  return { sent: d.notices.length, error: false };
}
