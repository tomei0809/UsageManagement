import { daysUntil } from "../../shared/series";
import type { DashboardResponse, MetricStatus } from "../../shared/types";
import { PollBadge } from "../components/AutoCollectPanel";
import { SourceBadge, StaleBadge } from "../components/Badges";
import { levelLabel, UsageBar } from "../components/UsageBar";
import { formatDate, formatDateTime, formatPercent, formatRelative, formatValue } from "../format";
import { useAsync } from "../useAsync";
import { api } from "../api";

const LEVEL_ORDER: MetricStatus["level"][] = ["limit", "warning", "caution", "ok", "unknown"];

export function Dashboard() {
  const { data, error, loading, reload } = useAsync(api.dashboard, []);

  if (loading && !data) return <p className="muted">読み込み中…</p>;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const all = data.services.flatMap((s) => s.metrics);
  const counts = Object.fromEntries(LEVEL_ORDER.map((l) => [l, all.filter((m) => m.level === l).length]));
  const staleCount = all.filter((m) => m.stale).length;

  return (
    <>
      <div className="page-head">
        <h1>ダッシュボード</h1>
        <a className="btn btn--primary" href="#/services/new">
          + サービスを追加
        </a>
      </div>

      {data.services.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <section className="summary" aria-label="概要">
            <SummaryTile label="上限到達" value={counts.limit ?? 0} level="limit" />
            <SummaryTile label="警告" value={counts.warning ?? 0} level="warning" />
            <SummaryTile label="注意" value={counts.caution ?? 0} level="caution" />
            <SummaryTile label="古いデータ" value={staleCount} level="stale" />
          </section>
          {!data.settings.schedulerEnabled && (
            <div className="card banner" role="status">
              アプリ全体の定期取得が<strong>停止中</strong>です。<a href="#/settings">設定</a>から再開できます。
            </div>
          )}
          <Alerts data={data} />
          <CostSummary data={data} />
          <section className="services">
            {sortServices(data).map(({ service, metrics, pollState }) => (
              <article key={service.id} className="card service">
                <header className="service__head">
                  <h2>
                    <a href={`#/services/${service.id}`}>{service.name}</a>
                  </h2>
                  {service.category && <span className="muted">{service.category}</span>}
                  <FreeTierChip endsAt={service.freeTierEndsAt} />
                  {pollState !== "manual" && (
                    <span className="service__poll">
                      <PollBadge state={pollState} title={service.pauseReason ?? undefined} />
                      {service.lastError && service.consecutiveFailures > 0 && (
                        <span className="badge run--failed" title={service.lastError}>
                          取得失敗{service.consecutiveFailures > 1 ? ` ×${service.consecutiveFailures}` : ""}
                        </span>
                      )}
                    </span>
                  )}
                </header>
                {metrics.length === 0 ? (
                  <p className="muted">
                    指標が未登録です。<a href={`#/services/${service.id}`}>指標を追加</a>
                  </p>
                ) : (
                  <ul className="metric-list">
                    {metrics.map((s) => (
                      <MetricRow key={s.metric.id} status={s} />
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>
          <p className="muted small">更新: {formatDateTime(data.generatedAt)}</p>
        </>
      )}
    </>
  );
}

/** 無料期間の残り日数(終了日まで無料。終了日の翌日 0 時 UTC に終了) */
function FreeTierChip({ endsAt }: { endsAt: string | null }) {
  if (!endsAt) return null;
  const end = new Date(`${endsAt}T00:00:00Z`).getTime() + 86_400_000;
  const days = Math.ceil((end - Date.now()) / 86_400_000);
  if (days <= 0) return <span className="chip chip--limit">無料期間終了</span>;
  return (
    <span className={`chip ${days <= 7 ? "chip--warning" : days <= 30 ? "chip--caution" : "chip--muted"}`} title={`終了日 ${endsAt}`}>
      無料期間 あと{days}日
    </span>
  );
}

/** 単位が USD の指標(料金)をまとめて表示。上限 = 予算 */
function CostSummary({ data }: { data: DashboardResponse }) {
  const rows = data.services.flatMap((s) =>
    s.metrics.filter((m) => m.metric.unit.toUpperCase() === "USD").map((m) => ({ service: s.service, status: m })),
  );
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + (r.status.latest?.value ?? 0), 0);
  const projectedTotal = rows.reduce((sum, r) => sum + (r.status.forecast?.projected ?? r.status.latest?.value ?? 0), 0);
  const budgets = rows.filter((r) => r.status.metric.limitValue !== null);
  const budgetTotal = budgets.reduce((sum, r) => sum + r.status.metric.limitValue!, 0);
  return (
    <section className="card costs" aria-label="今期の料金">
      <div className="page-head">
        <h2>今期の料金</h2>
        <div className="costs__total">
          <strong>{formatValue(total, "USD")}</strong>
          {budgets.length === rows.length && budgetTotal > 0 && (
            <span className="muted"> / 予算 {formatValue(budgetTotal, "USD")}</span>
          )}
          {projectedTotal > total && (
            <span className="forecast-inline">
              <span className="forecast__tag">予測</span> 期末 {formatValue(projectedTotal, "USD")}
            </span>
          )}
        </div>
      </div>
      <table className="series-table">
        <thead>
          <tr>
            <th>サービス / 指標</th>
            <th className="num">今期</th>
            <th className="num">予算</th>
            <th className="num">使用率</th>
            <th>リセット</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ service, status }) => (
            <tr key={status.metric.id}>
              <td>
                <a href={`#/services/${service.id}`}>{service.name}</a> / {status.metric.label}
              </td>
              <td className="num">{formatValue(status.latest?.value ?? null, "USD")}</td>
              <td className="num">{status.metric.limitValue === null ? "未設定" : formatValue(status.metric.limitValue, "USD")}</td>
              <td className="num">{formatPercent(status.percent)}</td>
              <td>{status.nextResetAt ? formatDate(status.nextResetAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        単位が USD の指標を合計しています。指標の「上限値」を予算として使います(未設定なら使用率は出ません)。
        手動入力の料金(AWS・Vercel など)も、単位 USD の指標を作れば含まれます。
      </p>
    </section>
  );
}

/** 深刻度の高い指標を持つサービスを上に */
function sortServices(data: DashboardResponse) {
  const rank = (ms: MetricStatus[]) => Math.min(...ms.map((m) => LEVEL_ORDER.indexOf(m.level)), LEVEL_ORDER.length);
  return [...data.services].sort((a, b) => rank(a.metrics) - rank(b.metrics));
}

export function MetricRow({ status, hideLabel }: { status: MetricStatus; hideLabel?: boolean }) {
  const { metric, latest, remaining, nextResetAt, stale } = status;
  return (
    <li className="metric">
      {!hideLabel && <div className="metric__label">{metric.label}</div>}
      <UsageBar status={status} />
      <dl className="metric__meta">
        <div>
          <dt>残り</dt>
          <dd>{remaining === null ? "—" : formatValue(remaining, metric.unit)}</dd>
        </div>
        <div>
          <dt>次回リセット</dt>
          <dd>
            {nextResetAt
              ? `${formatDate(nextResetAt)}(あと${daysUntil(nextResetAt, new Date())}日)`
              : metric.resetType === "rolling"
                ? `直近${metric.resetAnchor}時間`
                : "なし"}
          </dd>
        </div>
        <div>
          <dt>最終更新</dt>
          <dd title={formatDateTime(latest?.collectedAt)}>{formatRelative(latest?.collectedAt)}</dd>
        </div>
        <div className="metric__badges">
          <SourceBadge source={latest?.source} />
          <StaleBadge stale={stale} />
        </div>
      </dl>
      <ForecastLine status={status} />
    </li>
  );
}

/** 予測は実測と区別して「予測」ラベル付き・破線枠で表示する */
function ForecastLine({ status }: { status: MetricStatus }) {
  const { forecast: f, metric, level } = status;
  if (!f) return null;
  const pace = `${formatValue(f.pacePerDay, metric.unit)}/日`;
  const basis = f.method === "7d" ? "直近7日のペース" : "期間開始からのペース";
  return (
    <p className={`forecast ${f.willExceed ? "forecast--exceed" : ""}`}>
      <span className="forecast__tag">予測</span>
      {f.projected !== null ? (
        <>
          期末 {formatValue(f.projected, metric.unit)} / {formatValue(metric.limitValue, metric.unit)}({formatPercent(f.projectedPercent)})
        </>
      ) : (
        <>増加ペース {pace}</>
      )}
      {f.willExceed && level !== "limit" && f.exceedAt && (
        <strong className="forecast__warn">
          {" "}
          · {formatDate(f.exceedAt)}ごろ上限に達する見込み
        </strong>
      )}
      <span className="muted">
        {" "}
        ({basis}{f.projected !== null ? `: ${pace}` : ""})
      </span>
    </p>
  );
}

/** 注意以上の指標を深刻度順に一覧(閾値は指標ごとの設定) */
function Alerts({ data }: { data: DashboardResponse }) {
  const items = data.services
    .flatMap((s) => s.metrics.map((m) => ({ service: s.service, status: m })))
    .filter(
      (x) =>
        x.status.level === "limit" ||
        x.status.level === "warning" ||
        x.status.level === "caution" ||
        x.status.forecast?.willExceed,
    )
    .sort((a, b) => LEVEL_ORDER.indexOf(a.status.level) - LEVEL_ORDER.indexOf(b.status.level));
  if (items.length === 0) return null;
  return (
    <section className="card alerts" aria-label="要対応">
      <h2>要対応</h2>
      <ul>
        {items.map(({ service, status }) => (
          <li key={status.metric.id}>
            {status.level === "ok" || status.level === "unknown" ? (
              <span className="chip chip--forecast">超過見込み</span>
            ) : (
              <span className={`chip chip--${status.level}`}>{levelLabel(status.level)}</span>
            )}
            <a href={`#/services/${service.id}`}>
              {service.name} / {status.metric.label}
            </a>
            <strong>{formatPercent(status.percent)}</strong>
            <span className="muted small">
              残り {status.remaining === null ? "—" : formatValue(status.remaining, status.metric.unit)}
              {status.nextResetAt && ` · リセットまであと${daysUntil(status.nextResetAt, new Date())}日`}
              {status.forecast?.willExceed && status.forecast.exceedAt && status.level !== "limit" &&
                ` · 予測: ${formatDate(status.forecast.exceedAt)}ごろ上限`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SummaryTile(props: { label: string; value: number; level: string }) {
  return (
    <div className={`tile tile--${props.level} ${props.value === 0 ? "tile--zero" : ""}`}>
      <span className="tile__value">{props.value}</span>
      <span className="tile__label">{props.label}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card empty">
      <h2>まだサービスがありません</h2>
      <p>
        監視したいサービス(例: GitHub Actions)を追加し、指標(例: 実行時間 / 上限 2000 minutes / 毎月1日リセット)を登録してください。
        使用量は各サービスの管理画面を見て手動で入力できます。
      </p>
      <a className="btn btn--primary" href="#/services/new">
        サービスを追加
      </a>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card error-box" role="alert">
      <p>エラー: {message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          再試行
        </button>
      )}
    </div>
  );
}
