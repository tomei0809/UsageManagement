import { useState, type FormEvent } from "react";
import type { ResetType } from "../../shared/period";
import type { Metric, MetricInput, MetricKind } from "../../shared/types";

const RESET_OPTIONS: { value: ResetType; label: string }[] = [
  { value: "monthly", label: "毎月(指定日)" },
  { value: "daily", label: "毎日" },
  { value: "weekly", label: "毎週(指定曜日)" },
  { value: "rolling", label: "ローリング(直近N時間)" },
  { value: "none", label: "リセットなし" },
];

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const UNIT_SUGGESTIONS = ["minutes", "requests", "bytes", "GB", "USD", "回", "%"];

const TIMEZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "America/New_York", "Europe/London"];

const defaults: MetricInput = {
  key: "",
  label: "",
  unit: "",
  kind: "cumulative",
  limitValue: null,
  resetType: "monthly",
  resetAnchor: 1,
  resetTimezone: "UTC",
  cautionPct: 80,
  warningPct: 95,
  staleAfterHours: 48,
  sortOrder: 0,
};

function defaultAnchor(t: ResetType): number | null {
  return t === "monthly" ? 1 : t === "weekly" ? 1 : t === "rolling" ? 5 : null;
}

export function MetricForm(props: {
  initial?: Metric;
  onSubmit: (input: MetricInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState<MetricInput>(() => (props.initial ? { ...defaults, ...props.initial } : defaults));
  const [limitText, setLimitText] = useState(props.initial?.limitValue?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof MetricInput>(k: K, val: MetricInput[K]) => setV((p) => ({ ...p, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const limit = limitText.trim() === "" ? null : Number(limitText);
    if (limit !== null && !(limit > 0)) return setError("上限は正の数で入力してください(空欄 = 上限なし)");
    setBusy(true);
    try {
      await props.onSubmit({ ...v, limitValue: limit });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const unitIsBytes = v.unit.toLowerCase() === "bytes";

  return (
    <form className="form card" onSubmit={submit}>
      <h3>{props.initial ? "指標を編集" : "指標を追加"}</h3>
      <div className="grid2">
        <label>
          表示名
          <input required value={v.label} onChange={(e) => set("label", e.target.value)} placeholder="例: 実行時間" />
        </label>
        <label>
          キー(英小文字)
          <input
            required
            value={v.key}
            onChange={(e) => set("key", e.target.value)}
            placeholder="例: actions-minutes"
            pattern="[a-z0-9][a-z0-9_.\-]*"
          />
        </label>
        <label>
          単位
          <input
            required
            list="unit-suggestions"
            value={v.unit}
            onChange={(e) => set("unit", e.target.value)}
            placeholder="例: minutes"
          />
          <datalist id="unit-suggestions">
            {UNIT_SUGGESTIONS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </label>
        <label>
          上限値{unitIsBytes ? "(bytes)" : ""}
          <input
            inputMode="decimal"
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
            placeholder="空欄 = 上限なし"
          />
        </label>
        <label>
          種類
          <select value={v.kind} onChange={(e) => set("kind", e.target.value as MetricKind)}>
            <option value="cumulative">期間内に積み上がる(実行時間・リクエスト数・料金)</option>
            <option value="gauge">その時点の量(ストレージ容量など)</option>
          </select>
        </label>
        <label>
          リセット方式
          <select
            value={v.resetType}
            onChange={(e) => {
              const t = e.target.value as ResetType;
              setV((p) => ({ ...p, resetType: t, resetAnchor: defaultAnchor(t) }));
            }}
          >
            {RESET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {v.resetType === "monthly" && (
          <label>
            リセット日(毎月)
            <input
              type="number"
              min={1}
              max={31}
              value={v.resetAnchor ?? 1}
              onChange={(e) => set("resetAnchor", Number(e.target.value))}
            />
            <small className="muted">月の日数を超える場合は末日</small>
          </label>
        )}
        {v.resetType === "weekly" && (
          <label>
            リセット曜日
            <select value={v.resetAnchor ?? 1} onChange={(e) => set("resetAnchor", Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}曜日
                </option>
              ))}
            </select>
          </label>
        )}
        {v.resetType === "rolling" && (
          <label>
            ウィンドウ(時間)
            <input
              type="number"
              min={1}
              value={v.resetAnchor ?? 5}
              onChange={(e) => set("resetAnchor", Number(e.target.value))}
            />
          </label>
        )}
        {(v.resetType === "monthly" || v.resetType === "daily" || v.resetType === "weekly") && (
          <label>
            リセット基準のタイムゾーン
            <input list="tz-suggestions" value={v.resetTimezone} onChange={(e) => set("resetTimezone", e.target.value)} />
            <datalist id="tz-suggestions">
              {TIMEZONES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
        )}
        <label>
          注意の閾値(%)
          <input
            type="number"
            min={0}
            max={1000}
            value={v.cautionPct}
            onChange={(e) => set("cautionPct", Number(e.target.value))}
          />
        </label>
        <label>
          警告の閾値(%)
          <input
            type="number"
            min={0}
            max={1000}
            value={v.warningPct}
            onChange={(e) => set("warningPct", Number(e.target.value))}
          />
        </label>
        <label>
          「古いデータ」とみなす時間
          <input
            type="number"
            min={1}
            value={v.staleAfterHours}
            onChange={(e) => set("staleAfterHours", Number(e.target.value))}
          />
        </label>
        <label>
          表示順
          <input type="number" value={v.sortOrder} onChange={(e) => set("sortOrder", Number(e.target.value))} />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          保存
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
