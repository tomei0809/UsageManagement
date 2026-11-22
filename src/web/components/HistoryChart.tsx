import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isAccumulating } from "../../shared/series";
import type { Forecast } from "../../shared/forecast";
import type { Metric, SeriesResponse } from "../../shared/types";
import { api } from "../api";
import { byteTicks, formatAxis, formatValue, unitSuffix } from "../format";
import { useAsync } from "../useAsync";

type Range = { granularity: "day"; days: number } | { granularity: "month"; months: number };

const RANGES: { label: string; range: Range }[] = [
  { label: "30日", range: { granularity: "day", days: 30 } },
  { label: "90日", range: { granularity: "day", days: 90 } },
  { label: "12か月", range: { granularity: "month", months: 12 } },
];

/** CSS 変数(ライト/ダークで切り替わる)を Recharts に渡すために読む */
function useChartColors() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim();
    return { series: v("--series"), grid: v("--border"), ink: v("--muted"), ref: v("--text"), surface: v("--surface") };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setC(read());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return c;
}

export function HistoryChart({ metric, refreshKey, forecast }: { metric: Metric; refreshKey: unknown; forecast?: Forecast | null }) {
  const [idx, setIdx] = useState(0);
  const [asTable, setAsTable] = useState(false);
  const range = RANGES[idx]!.range;
  const { data, error } = useAsync(
    () =>
      api.series(
        metric.id,
        range.granularity,
        range.granularity === "day" ? range.days : range.months,
      ),
    [metric.id, idx, refreshKey],
  );

  return (
    <div className="history-chart">
      <div className="chart-controls" role="group" aria-label="表示期間">
        {RANGES.map((r, i) => (
          <button
            key={r.label}
            className={`seg ${i === idx ? "seg--on" : ""}`}
            aria-pressed={i === idx}
            onClick={() => setIdx(i)}
          >
            {r.label}
          </button>
        ))}
        <label className="table-toggle">
          <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} /> 表で見る
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {data && (asTable ? <SeriesTable metric={metric} data={data} /> : <Charts metric={metric} data={data} forecast={forecast ?? null} />)}
    </div>
  );
}

function Charts({ metric, data, forecast }: { metric: Metric; data: SeriesResponse; forecast: Forecast | null }) {
  const c = useChartColors();
  const fmt = (v: number) => formatValue(v, metric.unit);
  const axisTick = { fill: c.ink, fontSize: 12 };
  const acc = isAccumulating(metric);
  const limit = metric.limitValue;

  const limitLine = (show: boolean) =>
    show && limit !== null ? (
      <ReferenceLine
        y={limit}
        stroke={c.ref}
        strokeDasharray="4 4"
        ifOverflow="extendDomain"
        label={{ value: `上限 ${fmt(limit)}`, position: "insideBottomRight", fill: c.ink, fontSize: 12 }}
      />
    ) : null;

  const tooltip = (
    <Tooltip
      cursor={{ fill: c.grid, opacity: 0.4 }}
      contentStyle={{ background: c.surface, border: `1px solid ${c.grid}`, borderRadius: 8 }}
      labelStyle={{ color: c.ref }}
      itemStyle={{ color: c.ref }}
      formatter={(v) => (typeof v === "number" ? fmt(v) : "記録なし")}
    />
  );
  const common = {
    grid: <CartesianGrid stroke={c.grid} strokeDasharray="0" vertical={false} />,
  };
  const isBytes = metric.unit.toLowerCase() === "bytes";
  /** bytes は切りのよい目盛りを自前で計算(他の単位は Recharts の自動目盛り) */
  const yAxis = (values: (number | null)[], withLimit: boolean) => {
    const max = Math.max(0, ...values.filter((v): v is number => v !== null), withLimit && limit !== null ? limit : 0);
    const ticks = isBytes ? byteTicks(max) : undefined;
    return (
      <YAxis
        tick={axisTick}
        tickFormatter={(v: number) => formatAxis(v, metric.unit)}
        width={64}
        axisLine={false}
        tickLine={false}
        ticks={ticks}
        domain={ticks ? [0, ticks[ticks.length - 1]!] : [0, "auto"]}
      />
    );
  };

  if (data.granularity === "month") {
    const points = data.monthly;
    if (points.every((p) => p.value === null)) return <Empty />;
    return (
      <figure className="chart">
        <figcaption>
          {acc ? "月別の使用量" : "月末時点の値"}{unitSuffix(metric.unit)}
          {metric.resetType === "monthly" && metric.resetAnchor !== 1 ? "(リセット期間ごと)" : ""}
        </figcaption>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={points} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
            {common.grid}
            <XAxis dataKey="label" tick={axisTick} axisLine={{ stroke: c.grid }} tickLine={false} />
            {yAxis(points.map((p) => p.value), !acc || metric.resetType === "monthly")}
            {tooltip}
            <Bar dataKey="value" name={metric.label} fill={c.series} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            {limitLine(!acc || metric.resetType === "monthly")}
          </BarChart>
        </ResponsiveContainer>
      </figure>
    );
  }

  const points: DayPoint[] = data.daily.map((p) => ({ ...p, label: p.date.slice(5).replace("-", "/"), projected: null }));
  if (points.every((p) => p.value === null)) return <Empty />;
  // 期末までの予測線(破線)。実測の最後の点から期末まで、予測ペースで延ばす
  const withProjection = acc && forecast?.projected != null && forecast.horizon ? addProjection(points, forecast) : points;
  const hasProjection = withProjection !== points;
  const resetLines = points
    .filter((p) => p.resetDay)
    .map((p) => (
      <ReferenceLine
        key={p.date}
        x={p.label}
        stroke={c.ink}
        strokeDasharray="2 3"
        label={{ value: "リセット", position: "insideTopLeft", fill: c.ink, fontSize: 11 }}
      />
    ));
  const xAxis = (
    <XAxis dataKey="label" tick={axisTick} axisLine={{ stroke: c.grid }} tickLine={false} minTickGap={16} />
  );

  return (
    <>
      {acc && (
        <figure className="chart">
          <figcaption>日別の使用量{unitSuffix(metric.unit)}</figcaption>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={points} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
              {common.grid}
              {xAxis}
              {yAxis(points.map((p) => p.usage), metric.resetType === "daily")}
              {tooltip}
              <Bar dataKey="usage" name="使用量" fill={c.series} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
              {resetLines}
              {limitLine(metric.resetType === "daily")}
            </BarChart>
          </ResponsiveContainer>
        </figure>
      )}
      {!(acc && metric.resetType === "daily") && (
        <figure className="chart">
          <figcaption>
            {acc ? "当期の累計(リセットで 0 に戻る)" : "記録値の推移"}
            {unitSuffix(metric.unit)}
            {hasProjection && (
              <span className="legend">
                <span className="legend__solid" aria-hidden /> 実測
                <span className="legend__dashed" aria-hidden /> 予測(直近のペース)
              </span>
            )}
          </figcaption>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={withProjection} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              {common.grid}
              {xAxis}
              {yAxis([...withProjection.map((p) => p.value), ...withProjection.map((p) => p.projected)], true)}
              {tooltip}
              <Line
                type="linear"
                dataKey="value"
                name={acc ? "累計" : "値"}
                stroke={c.series}
                strokeWidth={2}
                dot={{ r: 3, fill: c.series, stroke: c.surface, strokeWidth: 2 }}
                activeDot={{ r: 5, stroke: c.surface, strokeWidth: 2 }}
                connectNulls
                isAnimationActive={false}
              />
              {hasProjection && (
                <Line
                  type="linear"
                  dataKey="projected"
                  name="予測"
                  stroke={c.series}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              )}
              {resetLines}
              {limitLine(true)}
            </LineChart>
          </ResponsiveContainer>
        </figure>
      )}
      <p className="muted small">
        {data.timezone} 基準で日を区切っています。
        {acc && "使用量は前回記録との差分です。記録を始めた日は期間開始からの累計を含みます。"}
      </p>
    </>
  );
}

function SeriesTable({ metric, data }: { metric: Metric; data: SeriesResponse }) {
  const acc = isAccumulating(metric);
  const rows =
    data.granularity === "month"
      ? data.monthly.map((p) => ({ key: p.start, label: p.label, a: p.value, b: undefined }))
      : data.daily.map((p) => ({ key: p.date, label: p.date, a: acc ? p.usage : p.value, b: acc ? p.value : undefined }));
  return (
    <table className="series-table">
      <thead>
        <tr>
          <th>{data.granularity === "month" ? "期間" : "日付"}</th>
          <th className="num">{acc ? "使用量" : "値"}</th>
          {data.granularity === "day" && acc && <th className="num">当期累計</th>}
        </tr>
      </thead>
      <tbody>
        {[...rows].reverse().map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            <td className="num">{r.a === null ? "—" : formatValue(r.a, metric.unit)}</td>
            {r.b !== undefined && <td className="num">{r.b === null ? "—" : formatValue(r.b, metric.unit)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty() {
  return <p className="muted">この期間の記録はありません。</p>;
}

type DayPoint = {
  date: string;
  label: string;
  usage: number | null;
  value: number | null;
  resetDay: boolean;
  projected: number | null;
};

/** 実測の最後の点(予測線の起点)から期末の前日まで、予測ペースで直線を延ばした点列を返す */
function addProjection(points: DayPoint[], f: Forecast): DayPoint[] {
  let lastIdx = -1;
  for (let i = points.length - 1; i >= 0; i--) if (points[i]!.value !== null) { lastIdx = i; break; }
  if (lastIdx < 0) return points;
  const last = points[lastIdx]!;
  const out = points.map((p, i) => (i === lastIdx ? { ...p, projected: p.value } : p));
  const lastDay = new Date(`${last.date}T00:00:00Z`).getTime();
  const horizonDay = new Date(f.horizon!).getTime() - 86_400_000; // 期末の前日まで
  for (let d = 1; lastDay + d * 86_400_000 <= horizonDay && d <= 62; d++) {
    const date = new Date(lastDay + d * 86_400_000).toISOString().slice(0, 10);
    out.push({
      date,
      label: date.slice(5).replace("-", "/"),
      usage: null,
      value: null,
      resetDay: false,
      projected: last.value! + f.pacePerDay * d,
    });
  }
  return out;
}
