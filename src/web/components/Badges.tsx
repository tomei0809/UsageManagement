import type { SnapshotSource } from "../../shared/types";

const SOURCE_LABEL: Record<SnapshotSource, string> = {
  api: "API取得",
  manual: "手動入力",
  estimate: "推定値",
};

export function SourceBadge({ source }: { source: SnapshotSource | null | undefined }) {
  if (!source) return <span className="badge badge--none">未記録</span>;
  return <span className={`badge badge--${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function StaleBadge({ stale }: { stale: boolean }) {
  return stale ? (
    <span className="badge badge--stale" title="最終更新から設定時間以上経過しています">
      データが古い
    </span>
  ) : null;
}
