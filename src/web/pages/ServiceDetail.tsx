import { lazy, Suspense, useState, type FormEvent } from "react";
import type { Metric, MetricStatus } from "../../shared/types";
import { api } from "../api";
import { SourceBadge } from "../components/Badges";
import { AutoCollectPanel } from "../components/AutoCollectPanel";
import { MetricForm } from "../components/MetricForm";
import { formatDateTime, formatValue, toLocalInput } from "../format";
import { navigate } from "../router";
import { useAsync } from "../useAsync";
import { ErrorBox, MetricRow } from "./Dashboard";
const HistoryChart = lazy(() => import("../components/HistoryChart").then((m) => ({ default: m.HistoryChart })));

const RESET_TEXT: Record<Metric["resetType"], (m: Metric) => string> = {
  monthly: (m) => `毎月${m.resetAnchor}日(${m.resetTimezone})`,
  daily: (m) => `毎日 0:00(${m.resetTimezone})`,
  weekly: (m) => `毎週${"日月火水木金土"[m.resetAnchor ?? 0]}曜日(${m.resetTimezone})`,
  rolling: (m) => `直近${m.resetAnchor}時間のローリング`,
  none: () => "リセットなし",
};

export function ServiceDetail({ id }: { id: number }) {
  const { data, error, loading, reload } = useAsync(
    () => Promise.all([api.getService(id), api.dashboard()]).then(([s, d]) => ({ ...s, dash: d })),
    [id],
  );
  const [adding, setAdding] = useState(false);
  // 記録の追加・補完のたびに増やし、グラフと履歴を読み直す
  const [version, setVersion] = useState(0);
  const refresh = () => {
    setVersion((v) => v + 1);
    reload();
  };

  if (loading && !data) return <p className="muted">読み込み中…</p>;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const { service, metrics } = data;
  const svcStatus = data.dash.services.find((s) => s.service.id === id);
  const statuses = new Map((svcStatus?.metrics ?? []).map((s) => [s.metric.id, s]));

  async function removeService() {
    if (!confirm(`「${service.name}」と全ての指標・履歴を削除します。よろしいですか?`)) return;
    await api.deleteService(id);
    navigate("/");
  }

  return (
    <>
      <p>
        <a href="#/">← ダッシュボード</a>
      </p>
      <div className="page-head">
        <div>
          <h1>{service.name}</h1>
          <p className="muted">
            {service.category}
            {service.url && (
              <>
                {service.category && " · "}
                <a href={service.url} target="_blank" rel="noreferrer noopener">
                  管理画面を開く ↗
                </a>
              </>
            )}
          </p>
        </div>
        <div className="actions">
          <a className="btn" href={`#/services/${id}/edit`}>
            編集
          </a>
          <button className="btn btn--danger" onClick={removeService}>
            削除
          </button>
        </div>
      </div>
      {service.notes && <p className="notes">{service.notes}</p>}

      <AutoCollectPanel service={service} pollState={svcStatus?.pollState ?? "manual"} onChanged={refresh} />

      {metrics.map((m) => (
        <MetricPanel key={m.id} metric={m} status={statuses.get(m.id)} version={version} onChanged={refresh} />
      ))}

      {adding ? (
        <MetricForm
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            await api.createMetric(id, input);
            setAdding(false);
            reload();
          }}
        />
      ) : (
        <button className="btn btn--primary" onClick={() => setAdding(true)}>
          + 指標を追加
        </button>
      )}
    </>
  );
}

function MetricPanel(props: { metric: Metric; status?: MetricStatus; version: number; onChanged: () => void }) {
  const { metric, status, version, onChanged } = props;
  const [editing, setEditing] = useState(false);
  const history = useAsync(() => api.listSnapshots(metric.id, 20), [metric.id, status?.latest?.id, version]);

  if (editing) {
    return (
      <MetricForm
        initial={metric}
        onCancel={() => setEditing(false)}
        onSubmit={async (input) => {
          await api.updateMetric(metric.id, input);
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  async function remove() {
    if (!confirm(`指標「${metric.label}」と履歴を削除します。よろしいですか?`)) return;
    await api.deleteMetric(metric.id);
    onChanged();
  }

  return (
    <section className="card metric-panel">
      <div className="page-head">
        <h2>{metric.label}</h2>
        <div className="actions">
          <button className="btn btn--small" onClick={() => setEditing(true)}>
            編集
          </button>
          <button className="btn btn--small btn--danger" onClick={remove}>
            削除
          </button>
        </div>
      </div>
      {status && (
        <ul className="metric-list">
          <MetricRow status={status} hideLabel />
        </ul>
      )}
      <p className="muted small">
        リセット: {RESET_TEXT[metric.resetType](metric)} / 種類: {metric.kind === "gauge" ? "その時点の量" : "期間内の累積"} /
        閾値: 注意 {metric.cautionPct}%・警告 {metric.warningPct}% / 取得方法: {metric.collectorId ? `API(${metric.collectorId})` : "手動入力"}
      </p>
      {metric.collectorId && (
        <label className="inline small">
          <input
            type="checkbox"
            checked={metric.pollingEnabled}
            onChange={async (e) => {
              await api.setMetricPolling(metric.id, e.target.checked);
              onChanged();
            }}
          />
          この指標を自動取得する(オフにすると取得値を保存しません。手動入力はできます)
        </label>
      )}

      <Suspense fallback={<p className="muted small">グラフを読み込み中…</p>}>
        <HistoryChart metric={metric} refreshKey={`${status?.latest?.id}-${version}`} forecast={status?.forecast} />
      </Suspense>

      <SnapshotForm metric={metric} onSaved={onChanged} />

      <details className="history">
        <summary>入力履歴(最新20件)</summary>
        {history.data && history.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th className="num">値</th>
                <th>取得方法</th>
                <th>メモ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.map((s) => (
                <tr key={s.id}>
                  <td>{formatDateTime(s.collectedAt)}</td>
                  <td className="num">{formatValue(s.value, metric.unit)}</td>
                  <td>
                    <SourceBadge source={s.source} />
                  </td>
                  <td>{s.note}</td>
                  <td>
                    {s.source === "manual" && (
                      <button
                        className="btn btn--small btn--ghost"
                        aria-label="この記録を削除"
                        onClick={async () => {
                          if (!confirm("この記録を削除しますか?")) return;
                          await api.deleteSnapshot(s.id);
                          onChanged();
                        }}
                      >
                        削除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">まだ記録がありません。</p>
        )}
      </details>
    </section>
  );
}

function SnapshotForm({ metric, onSaved }: { metric: Metric; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [at, setAt] = useState(() => toLocalInput(new Date()));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (value.trim() === "" || !(n >= 0)) return setError("0 以上の数値を入力してください");
    setBusy(true);
    setError(null);
    try {
      await api.addSnapshot(metric.id, { value: n, collectedAt: new Date(at).toISOString(), note: note || null });
      setValue("");
      setNote("");
      setAt(toLocalInput(new Date()));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="snapshot-form" onSubmit={submit}>
      <label>
        現在の使用量({metric.unit})
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required />
      </label>
      <label>
        確認日時
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
      </label>
      <label className="grow">
        メモ
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="任意" />
      </label>
      <button className="btn btn--primary" disabled={busy}>
        記録
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
