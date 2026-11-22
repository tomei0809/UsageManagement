import type { CollectorMeta } from "../../shared/collectors";

export interface Reading {
  metricKey: string;
  value: number;
  /** API が上限値を返す場合(Google Drive など)は指標の上限を自動更新する */
  limitValue?: number | null;
}

export interface CollectContext {
  /** 秘密でない設定 + 復号済みの秘密情報 */
  fields: Record<string, string>;
  now: Date;
  fetch: typeof fetch;
}

/** 過去分の補完: ある日(UTC)の終わり時点の値 */
export interface DailyReadings {
  /** YYYY-MM-DD(UTC) */
  date: string;
  readings: Reading[];
}

export interface Collector {
  meta: CollectorMeta;
  collect(ctx: CollectContext): Promise<Reading[]>;
  /**
   * 任意。当月 1 日〜昨日(UTC)の各日の終わり時点の値(collect と同じ意味の値。累積型なら月初からの累計)を返す。
   * 1 回の実行で外部 API を呼べる回数に上限があるため(Workers Free はサブリクエスト 50)、範囲は当月に限る。
   */
  backfill?(ctx: CollectContext): Promise<DailyReadings[]>;
}

export type CollectorErrorKind = "auth" | "not_supported" | "rate_limit" | "network" | "bad_response" | "config";

/** 画面に出せる(秘密情報を含まない)エラー */
export class CollectorError extends Error {
  constructor(
    public kind: CollectorErrorKind,
    message: string,
  ) {
    super(message);
  }
}
