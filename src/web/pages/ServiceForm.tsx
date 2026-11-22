import { useState, type FormEvent } from "react";
import type { ServiceInput } from "../../shared/types";
import { api } from "../api";
import { navigate } from "../router";
import { useAsync } from "../useAsync";
import { ErrorBox } from "./Dashboard";

export function ServiceForm({ id }: { id?: number }) {
  const existing = useAsync(() => (id ? api.getService(id) : Promise.resolve(null)), [id]);
  if (id && existing.loading) return <p className="muted">読み込み中…</p>;
  if (existing.error) return <ErrorBox message={existing.error} />;
  return <ServiceFormInner id={id} initial={existing.data?.service} />;
}

function ServiceFormInner({ id, initial }: { id?: number; initial?: ServiceInput }) {
  const [v, setV] = useState<ServiceInput>({
    name: initial?.name ?? "",
    category: initial?.category ?? "",
    url: initial?.url ?? "",
    notes: initial?.notes ?? "",
    freeTierEndsAt: initial?.freeTierEndsAt ?? "",
    pauseOnFreeTierEnd: initial?.pauseOnFreeTierEnd ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = id ? await api.updateService(id, v) : await api.createService(v);
      navigate(`/services/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{id ? "サービスを編集" : "サービスを追加"}</h1>
      </div>
      <form className="form card" onSubmit={submit}>
        <label>
          サービス名
          <input required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="例: GitHub Actions" />
        </label>
        <label>
          カテゴリ(任意)
          <input value={v.category ?? ""} onChange={(e) => setV({ ...v, category: e.target.value })} placeholder="例: CI / Hosting / AI" />
        </label>
        <label>
          管理画面のURL(任意・使用量の確認先)
          <input type="url" value={v.url ?? ""} onChange={(e) => setV({ ...v, url: e.target.value })} placeholder="https://" />
        </label>
        <label>
          メモ(任意)
          <textarea rows={3} value={v.notes ?? ""} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </label>
        <fieldset className="fieldset">
          <legend>無料期間(任意)</legend>
          <label>
            無料期間の終了日(この日まで無料)
            <input
              type="date"
              value={v.freeTierEndsAt ?? ""}
              onChange={(e) => setV({ ...v, freeTierEndsAt: e.target.value })}
            />
            <small className="muted">
              AWS の 12 か月無料枠やトライアルなど、期限のある無料期間がある場合に入力。30 日前・7 日前・終了時に通知します。
            </small>
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={v.pauseOnFreeTierEnd}
              disabled={!v.freeTierEndsAt}
              onChange={(e) => setV({ ...v, pauseOnFreeTierEnd: e.target.checked })}
            />
            無料期間が終わったら自動取得を止める(あとから「再開」で戻せます)
          </label>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="btn btn--primary" disabled={busy}>
            保存
          </button>
          <a className="btn" href={id ? `#/services/${id}` : "#/"}>
            キャンセル
          </a>
        </div>
      </form>
    </>
  );
}
