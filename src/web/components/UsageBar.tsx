import type { MetricStatus } from "../../shared/types";
import { formatPercent, formatValue } from "../format";

const LEVEL_LABEL: Record<MetricStatus["level"], string> = {
  ok: "正常",
  caution: "注意",
  warning: "警告",
  limit: "上限到達",
  unknown: "—",
};

export function levelLabel(level: MetricStatus["level"]) {
  return LEVEL_LABEL[level];
}

/** 使用率の横棒。色だけに頼らず、数値とレベル名も必ず併記する */
export function UsageBar({ status }: { status: MetricStatus }) {
  const { metric, latest, percent, level } = status;
  const width = percent === null ? 0 : Math.min(100, percent);
  const noLimit = metric.limitValue === null;

  return (
    <div className="usage">
      <div
        className={`bar bar--${level}`}
        role="meter"
        aria-label={`${metric.label} 使用率`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={percent === null ? "使用率なし" : `${formatPercent(percent)} ${LEVEL_LABEL[level]}`}
      >
        <div className="bar__fill" style={{ width: `${width}%` }} />
        {!noLimit && (
          <>
            <span className="bar__tick" style={{ left: `${Math.min(100, metric.cautionPct)}%` }} aria-hidden />
            <span className="bar__tick" style={{ left: `${Math.min(100, metric.warningPct)}%` }} aria-hidden />
          </>
        )}
      </div>
      <div className="usage__numbers">
        <strong className={`pct pct--${level}`}>{formatPercent(percent)}</strong>
        <span className="muted">
          {formatValue(latest?.value, metric.unit)}
          {noLimit ? "(上限なし)" : ` / ${formatValue(metric.limitValue, metric.unit)}`}
        </span>
        {level !== "ok" && level !== "unknown" && (
          <span className={`chip chip--${level}`}>{LEVEL_LABEL[level]}</span>
        )}
      </div>
    </div>
  );
}
