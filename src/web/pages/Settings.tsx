import { useState } from "react";
import type { AppSettings } from "../../shared/types";
import { api } from "../api";
import { useAsync } from "../useAsync";
import { ErrorBox } from "./Dashboard";

export function Settings() {
  const { data, error, reload } = useAsync(api.getSettings, []);
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <p className="muted">読み込み中…</p>;
  return <SettingsForm key={JSON.stringify(data)} initial={data} onSaved={reload} />;
}

function SettingsForm({ initial, onSaved }: { initial: AppSettings; onSaved: () => void }) {
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: AppSettings, text: string) {
    setBusy(true);
    setMsg(null);
    try {
      setV(await api.saveSettings(next));
      setMsg({ ok: true, text });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>設定</h1>
      </div>

      <section className="card">
        <h2>定期取得(アプリ全体)</h2>
        <p>
          現在:{" "}
          <strong className={v.schedulerEnabled ? "ok-text" : "error"}>{v.schedulerEnabled ? "有効(6時間ごと)" : "停止中"}</strong>
        </p>
        <p className="muted small">
          停止すると、すべてのサービスの自動取得を行いません(各サービスの「今すぐ取得」と手動入力は使えます)。
          サービス単位・指標単位の停止は、各サービスの詳細画面で設定できます。
        </p>
        <button
          className={`btn ${v.schedulerEnabled ? "btn--danger" : "btn--primary"}`}
          disabled={busy}
          onClick={() =>
            save(
              { ...v, schedulerEnabled: !v.schedulerEnabled },
              v.schedulerEnabled ? "定期取得を停止しました" : "定期取得を再開しました",
            )
          }
        >
          {v.schedulerEnabled ? "■ すべて停止" : "▶ 再開"}
        </button>
      </section>

      <section className="card">
        <h2>失敗時の自動停止</h2>
        <p className="muted small">
          同じサービスの取得が連続して失敗したら、そのサービスの定期取得を自動で停止します(トークン失効や API 変更のときに無駄な呼び出しを続けないため)。
          失敗すると次の再試行までの間隔が 6 → 12 → 24 → 48 時間と延びます。
        </p>
        <label className="inline">
          連続
          <input
            type="number"
            min={0}
            max={100}
            value={v.autoPauseAfter}
            onChange={(e) => setV({ ...v, autoPauseAfter: Number(e.target.value) })}
          />
          回失敗で停止(0 = 自動停止しない)
        </label>
        <div className="actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => save(v, "保存しました")}>
            保存
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Discord 通知</h2>
        <p className="muted small">
          使用率が 注意 → 警告 → 上限到達 と<strong>上がった時</strong>、期末までに上限を超えそうな時(予測)、無料期間の終了が近づいた時、
          自動取得が自動停止した時に送ります。同じ期間内で同じ通知は繰り返しません。
        </p>
        <p>
          通知:{" "}
          <strong className={v.notificationsEnabled ? "ok-text" : "error"}>{v.notificationsEnabled ? "有効" : "停止中"}</strong>{" "}
          <button
            className="btn btn--small"
            disabled={busy}
            onClick={() =>
              save(
                { ...v, notificationsEnabled: !v.notificationsEnabled },
                v.notificationsEnabled ? "通知を停止しました" : "通知を再開しました",
              )
            }
          >
            {v.notificationsEnabled ? "■ 停止" : "▶ 再開"}
          </button>
        </p>
        <WebhookForm hint={v.webhookHint} onSaved={(s) => { setV(s); onSaved(); }} />
      </section>

      <section className="card">
        <h2>定期実行そのものを止めるには</h2>
        <p className="small">
          上のボタンで止めても、Cloudflare の Cron は 6 時間ごとに Worker を起動し、すぐ終了します(無料枠への影響はごくわずか)。
          アプリを使わなくなった場合は、<code>wrangler.jsonc</code> の <code>triggers.crons</code> を <code>[]</code> にしてデプロイするか、
          Cloudflare ダッシュボードで Cron Trigger を削除してください。
        </p>
      </section>

      {msg && (
        <p className={msg.ok ? "ok-text" : "error"} role="status">
          {msg.text}
        </p>
      )}
    </>
  );
}

function WebhookForm({ hint, onSaved }: { hint: string | null; onSaved: (s: AppSettings) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(fn: () => Promise<unknown>, text: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "schedulerEnabled" in r) onSaved(r as AppSettings);
      setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <label>
        Webhook URL{hint && <span className="muted">(設定済み: {hint}。値は表示しません)</span>}
        <input
          type="password"
          autoComplete="off"
          value={url}
          placeholder={hint ? "変更する場合のみ入力" : "https://discord.com/api/webhooks/…"}
          onChange={(e) => setUrl(e.target.value)}
        />
        <small className="muted">
          Discord のチャンネル設定 → 連携サービス → ウェブフック で作成した URL。URL を知っていれば誰でも投稿できるので、暗号化して保存します。
        </small>
      </label>
      <div className="actions">
        <button className="btn btn--primary btn--small" disabled={busy || !url.trim()} onClick={() => run(() => api.setWebhook(url.trim()).then((s) => (setUrl(""), s)), "保存しました")}>
          保存
        </button>
        <button className="btn btn--small" disabled={busy || !hint} onClick={() => run(() => api.testWebhook(), "テスト通知を送りました。Discord を確認してください")}>
          テスト送信
        </button>
        {hint && (
          <button
            className="btn btn--small btn--danger"
            disabled={busy}
            onClick={() => confirm("Webhook URL を削除しますか?") && run(() => api.setWebhook(""), "削除しました")}
          >
            削除
          </button>
        )}
      </div>
      {msg && (
        <p className={msg.ok ? "ok-text" : "error"} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
