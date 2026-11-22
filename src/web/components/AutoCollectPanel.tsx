import { useState, type FormEvent } from "react";
import type { CollectorMeta } from "../../shared/collectors";
import { POLL_STATE_LABEL, type PollState } from "../../shared/schedule";
import type { Service } from "../../shared/types";
import { api } from "../api";
import { formatDateTime, formatRelative } from "../format";
import { useAsync } from "../useAsync";

const PAUSE_OPTIONS = [
  { label: "1日", days: 1 },
  { label: "7日", days: 7 },
  { label: "30日", days: 30 },
];

export function PollBadge({ state, title }: { state: PollState; title?: string }) {
  return (
    <span className={`badge poll poll--${state}`} title={title}>
      {POLL_STATE_LABEL[state]}
    </span>
  );
}

/** サービス詳細の「自動取得」欄:接続設定・今すぐ取得・停止/一時停止/再開・取得履歴 */
export function AutoCollectPanel(props: { service: Service; pollState: PollState; onChanged: () => void }) {
  const { service, pollState } = props;
  const conn = useAsync(() => Promise.all([api.collectors(), api.getConnection(service.id)]), [service.id, service.updatedAt]);
  const runs = useAsync(() => api.runs(service.id), [service.id, service.lastRunAt]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!conn.data) return conn.error ? <p className="error">{conn.error}</p> : null;
  const [collectors, connection] = conn.data;
  const meta = collectors.find((c) => c.id === connection.collectorId);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage({ ok: true, text: done });
      props.onChanged();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function collectNow() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.collectNow(service.id);
      setMessage(r.status === "success" ? { ok: true, text: `取得しました(${r.saved} 件保存)` } : { ok: false, text: r.error ?? "失敗しました" });
      props.onChanged();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function backfill() {
    if (!confirm(`${meta?.backfill ?? ""}\n\n実行しますか?(何度実行しても重複しません。手動入力や定期取得の記録がある日は上書きしません)`)) return;
    setBusy(true);
    setMessage({ ok: true, text: "過去分を取得しています…(数十秒かかることがあります)" });
    try {
      const r = await api.backfill(service.id);
      setMessage({ ok: true, text: `${r.days} 日分を確認し、${r.saved} 件の記録を追加しました` });
      props.onChanged();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!connection.collectorId || editing) {
    return (
      <section className="card">
        <h2>自動取得</h2>
        <ConnectForm
          serviceId={service.id}
          collectors={collectors}
          initialId={connection.collectorId}
          config={connection.config}
          hasSecrets={connection.hasSecrets}
          onCancel={connection.collectorId ? () => setEditing(false) : undefined}
          onSaved={() => {
            setEditing(false);
            props.onChanged();
          }}
        />
      </section>
    );
  }

  const paused = pollState === "paused" || pollState === "stopped";
  return (
    <section className="card">
      <div className="page-head">
        <h2>
          自動取得: {meta?.name ?? connection.collectorId} <PollBadge state={pollState} />
        </h2>
        <div className="actions">
          {meta?.backfill && (
            <button
              className="btn btn--small"
              disabled={busy || new Date().getUTCDate() === 1}
              title={meta.backfill}
              onClick={backfill}
            >
              今月の過去分を取得
            </button>
          )}
          <button className="btn btn--primary btn--small" disabled={busy} onClick={collectNow}>
            今すぐ取得
          </button>
        </div>
      </div>

      <dl className="kv">
        <dt>最終取得</dt>
        <dd>
          {service.lastRunAt ? `${formatDateTime(service.lastRunAt)}(${formatRelative(service.lastRunAt)})` : "まだ実行していません"}
        </dd>
        <dt>最終成功</dt>
        <dd>{formatDateTime(service.lastSuccessAt)}</dd>
        {service.lastError && (
          <>
            <dt>直近のエラー</dt>
            <dd className="error">
              {service.lastError}
              {service.consecutiveFailures > 1 && `(連続 ${service.consecutiveFailures} 回)`}
            </dd>
          </>
        )}
        {pollState === "backoff" && (
          <>
            <dt>次の再試行</dt>
            <dd>{formatDateTime(service.nextRunAt)} 以降の定期実行</dd>
          </>
        )}
        {pollState === "paused" && (
          <>
            <dt>一時停止</dt>
            <dd>{formatDateTime(service.pausedUntil)} まで(自動で再開)</dd>
          </>
        )}
        {service.pauseReason && (pollState === "stopped" || pollState === "paused") && (
          <>
            <dt>理由</dt>
            <dd>{service.pauseReason}</dd>
          </>
        )}
        <dt>認証情報</dt>
        <dd className="muted">{connection.secretHint ?? "—"}(値は表示しません)</dd>
      </dl>

      <div className="actions polling-actions" role="group" aria-label="定期取得の停止と再開">
        {paused ? (
          <button className="btn btn--small" disabled={busy} onClick={() => act(() => api.setPolling(service.id, { enabled: true }), "定期取得を再開しました")}>
            ▶ 再開
          </button>
        ) : (
          <>
            {pollState === "backoff" && (
              <button
                className="btn btn--small"
                disabled={busy}
                title="失敗回数をリセットし、次の定期実行で取得します"
                onClick={() => act(() => api.setPolling(service.id, { enabled: true }), "再試行待ちを解除しました")}
              >
                再試行待ちを解除
              </button>
            )}
            <span className="muted small">一時停止:</span>
            {PAUSE_OPTIONS.map((o) => (
              <button
                key={o.days}
                className="btn btn--small"
                disabled={busy || pollState === "global-stopped"}
                onClick={() =>
                  act(
                    () =>
                      api.setPolling(service.id, {
                        enabled: true,
                        pausedUntil: new Date(Date.now() + o.days * 86_400_000).toISOString(),
                        reason: `${o.label}間の一時停止`,
                      }),
                    `${o.label}間 一時停止しました`,
                  )
                }
              >
                {o.label}
              </button>
            ))}
            <button
              className="btn btn--small"
              disabled={busy || pollState === "global-stopped"}
              onClick={() => act(() => api.setPolling(service.id, { enabled: false }), "定期取得を停止しました")}
            >
              ■ 停止
            </button>
          </>
        )}
        <span className="spacer" />
        <button className="btn btn--small" onClick={() => setEditing(true)}>
          接続設定を変更
        </button>
        <button
          className="btn btn--small btn--danger"
          disabled={busy}
          onClick={() => {
            if (confirm("自動取得の設定と保存済みの認証情報を削除します(記録済みの履歴は残ります)。よろしいですか?")) {
              void act(() => api.disconnect(service.id), "自動取得を解除しました");
            }
          }}
        >
          解除
        </button>
      </div>
      {pollState === "global-stopped" && (
        <p className="muted small">
          アプリ全体の定期取得が停止中です。<a href="#/settings">設定</a>から再開できます。「今すぐ取得」は使えます。
        </p>
      )}
      {message && (
        <p className={message.ok ? "ok-text" : "error"} role="status">
          {message.text}
        </p>
      )}

      <details className="history">
        <summary>取得履歴(最新20件)</summary>
        {runs.data && runs.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>開始</th>
                <th>結果</th>
                <th>エラー</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.startedAt)}</td>
                  <td>
                    <span className={`badge run--${r.status}`}>{RUN_LABEL[r.status] ?? r.status}</span>
                  </td>
                  <td className="small">{r.errorMessage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">まだ実行していません。</p>
        )}
      </details>
      {meta && <Caveats meta={meta} />}
    </section>
  );
}

const RUN_LABEL: Record<string, string> = {
  success: "成功",
  failed: "失敗",
  running: "実行中",
  partial: "一部成功",
  skipped: "スキップ",
};

function Caveats({ meta }: { meta: CollectorMeta }) {
  return (
    <details className="history">
      <summary>このコレクターについて</summary>
      <p className="small">{meta.description}</p>
      <ul className="small">
        {meta.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <a className="small" href={meta.docsUrl} target="_blank" rel="noreferrer noopener">
        公式ドキュメント ↗
      </a>
    </details>
  );
}

function ConnectForm(props: {
  collectors: CollectorMeta[];
  initialId: string | null;
  config: Record<string, string>;
  hasSecrets: boolean;
  onCancel?: () => void;
  onSaved: () => void;
  serviceId: number;
}) {
  const [id, setId] = useState(props.initialId ?? "");
  const [values, setValues] = useState<Record<string, string>>(props.config);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = props.collectors.find((c) => c.id === id);
  const keepSecrets = props.hasSecrets && id === props.initialId;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      await api.connect(props.serviceId, meta.id, values);
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted small">
        公式 API で使用量を自動取得します(6時間ごと)。自動取得できないサービスは、このまま手動入力で使えます。
      </p>
      <label>
        取得方法
        <select value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">— 選択してください —</option>
          {props.collectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {meta && (
        <>
          <p className="small">{meta.description}</p>
          {meta.caveats.length > 0 && (
            <ul className="caveats small">
              {meta.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <div className="grid2">
            {meta.fields.map((f) => (
              <label key={f.key}>
                {f.label}
                {f.secret && <span className="muted">(暗号化して保存)</span>}
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={values[f.key] ?? ""}
                  placeholder={f.secret && keepSecrets ? "変更しない場合は空欄" : f.placeholder}
                  required={!f.secret || !keepSecrets}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
                {f.help && <small className="muted">{f.help}</small>}
              </label>
            ))}
          </div>
          <p className="muted small">
            接続すると指標「{meta.metrics.map((m) => m.label).join("」「")}」が作成されます(既にあれば再利用)。
            上限値(無料枠)は自動では入らないので、各サービスの公式ページで確認して指標の編集から入力してください。
          </p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="btn btn--primary" disabled={busy || !meta}>
          保存して接続
        </button>
        {props.onCancel && (
          <button type="button" className="btn" onClick={props.onCancel}>
            キャンセル
          </button>
        )}
      </div>
    </form>
  );
}
