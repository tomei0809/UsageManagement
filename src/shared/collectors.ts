/**
 * コレクター(自動取得)の定義メタデータ。画面の入力フォームと、接続時に作る指標のひな形に使う。
 * 実際の取得処理は src/worker/collectors/ にある。
 *
 * 注意: 上限値(無料枠)はひな形に含めない。プランや時期で変わるため、ユーザーが公式ページで確認して入力する。
 */
import type { ResetType } from "./period";
import type { MetricKind } from "./types";

export interface CollectorField {
  key: string;
  label: string;
  /** true は暗号化して保存し、画面には二度と表示しない */
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface MetricTemplate {
  key: string;
  label: string;
  unit: string;
  kind: MetricKind;
  resetType: ResetType;
  resetAnchor: number | null;
  resetTimezone: string;
  /** 「古いデータ」とみなす時間(既定 48)。1 日 1 回更新のメトリクスは長めにする */
  staleAfterHours?: number;
}

export interface CollectorMeta {
  id: string;
  name: string;
  description: string;
  /** 公式ドキュメントで確認できていない点(実アカウントで要検証) */
  caveats: string[];
  docsUrl: string;
  fields: CollectorField[];
  metrics: MetricTemplate[];
  /** ローカル開発専用(ENABLE_DEMO_COLLECTOR=true のときだけ表示) */
  devOnly?: boolean;
  /** 当月の過去分(1 日〜昨日)を日別に補完できる場合の説明 */
  backfill?: string;
}

/** 過去分の補完で作った記録の目印(snapshots.note)。再実行時はこの記録だけを入れ替える */
export const BACKFILL_NOTE = "過去分を補完";

export const COLLECTORS: CollectorMeta[] = [
  {
    id: "github-actions",
    name: "GitHub Actions",
    description: "GitHub の課金 API から、当月の Actions 使用分数と超過料金(netAmount)を取得します。",
    caveats: [
      "個人アカウント向け課金 API は「enhanced billing platform」を利用できるアカウントのみ対象と記載されています。",
      "ユーザー向けエンドポイントに Actions の使用量が含まれること、Fine-grained トークンは Account permissions の「Plan: Read-only」で取得できることを実アカウントで確認済み(2026-11-22)。",
      "集計エンドポイント(/usage/summary)はパブリックプレビューです。",
    ],
    docsUrl: "https://docs.github.com/en/rest/billing/usage",
    backfill: "当月 1 日〜昨日(UTC)の使用量を 1 日ずつ取得し、日別グラフを埋めます(API を最大 30 回呼びます)。",
    fields: [
      { key: "username", label: "GitHub ユーザー名", secret: false, placeholder: "octocat" },
      {
        key: "token",
        label: "Personal access token",
        secret: true,
        help: "Fine-grained トークンで、Resource owner を自分にし、Account permissions の「Plan」を Read-only にしてください(これが無いと HTTP 403)。",
      },
    ],
    metrics: [
      { key: "actions-minutes", label: "Actions 実行時間", unit: "minutes", kind: "cumulative", resetType: "monthly", resetAnchor: 1, resetTimezone: "UTC" },
      { key: "actions-net-usd", label: "Actions 超過料金", unit: "USD", kind: "cumulative", resetType: "monthly", resetAnchor: 1, resetTimezone: "UTC" },
    ],
  },
  {
    id: "cloudflare-workers",
    name: "Cloudflare Workers",
    description: "GraphQL Analytics API から、アカウント全体の当日(UTC)の Workers リクエスト数を取得します。",
    caveats: ["Workers Free の上限は 1 日あたりのリクエスト数で、UTC 0 時にリセットされると記載されています。"],
    docsUrl: "https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/",
    fields: [
      { key: "accountId", label: "Account ID", secret: false, help: "ダッシュボードの URL やアカウント概要に表示される ID" },
      { key: "token", label: "API トークン", secret: true, help: "権限: Account → Account Analytics → Read のみ" },
    ],
    metrics: [
      { key: "workers-requests", label: "Workers リクエスト数(当日)", unit: "requests", kind: "cumulative", resetType: "daily", resetAnchor: null, resetTimezone: "UTC" },
    ],
  },
  {
    id: "openai-costs",
    name: "OpenAI API",
    description: "Costs API から当月(UTC)の利用料金の合計を取得します。プリペイド残高は取得できません。",
    caveats: ["Admin キーが必要です(通常の API キーでは取得できません)。", "料金データの確定までの遅延は公式に記載がありません。"],
    docsUrl: "https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage",
    fields: [{ key: "adminKey", label: "Admin キー", secret: true, help: "組織設定の Admin keys で発行" }],
    metrics: [
      { key: "openai-cost-usd", label: "当月の利用料金", unit: "USD", kind: "cumulative", resetType: "monthly", resetAnchor: 1, resetTimezone: "UTC" },
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Drive API(about.get)から使用容量と上限を取得します。上限は API の値で自動更新されます。",
    caveats: [
      "OAuth クライアントとリフレッシュトークンを自分で用意する必要があります(OAuth 2.0 Playground などで取得)。",
      "OAuth 同意画面が「テスト」状態のとき、リフレッシュトークンが短期間で失効する場合があります(要検証)。",
    ],
    docsUrl: "https://developers.google.com/workspace/drive/api/reference/rest/v3/about",
    fields: [
      { key: "clientId", label: "OAuth クライアント ID", secret: false },
      { key: "clientSecret", label: "OAuth クライアントシークレット", secret: true },
      { key: "refreshToken", label: "リフレッシュトークン", secret: true, help: "スコープは drive.metadata.readonly で十分な想定(要検証)" },
    ],
    metrics: [
      { key: "drive-storage", label: "ストレージ使用量", unit: "bytes", kind: "gauge", resetType: "none", resetAnchor: null, resetTimezone: "UTC" },
    ],
  },
  {
    id: "aws-s3",
    name: "AWS S3",
    description:
      "CloudWatch の S3 日次ストレージメトリクスから、バケットの使用容量(S3 Standard)とオブジェクト数を取得します。",
    caveats: [
      "値は 1 日 1 回しか報告されず、約 1 日遅れます(作成直後のバケットは最初の報告まで待つ必要があります)。",
      "S3 の日次ストレージメトリクスは無料です。読み取りに使う GetMetricStatistics は CloudWatch の無料 API リクエスト枠(月 100 万)の対象です(GetMetricData は常に課金されるため使いません)。",
      "リクエスト数は有料のリクエストメトリクスが必要なため取得しません(手動入力)。",
      "CloudWatch の読み取りだけを許可した専用の IAM ユーザーのキーを使ってください。ルートユーザーのキーは使わないでください。",
      "通信形式(AWS Query / XML)は公式 API リファレンスに明記がないため、実アカウントでの確認が必要です。",
    ],
    docsUrl: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudwatch-monitoring.html",
    fields: [
      { key: "region", label: "リージョン", secret: false, placeholder: "ap-northeast-1", help: "バケットのあるリージョン" },
      { key: "bucket", label: "バケット名", secret: false },
      { key: "accessKeyId", label: "アクセスキー ID", secret: true, placeholder: "AKIA…" },
      {
        key: "secretAccessKey",
        label: "シークレットアクセスキー",
        secret: true,
        help: "IAM ポリシーは cloudwatch:GetMetricStatistics のみ許可を推奨",
      },
    ],
    metrics: [
      { key: "s3-storage-bytes", label: "S3 使用容量(Standard)", unit: "bytes", kind: "gauge", resetType: "none", resetAnchor: null, resetTimezone: "UTC", staleAfterHours: 72 },
      { key: "s3-objects", label: "S3 オブジェクト数", unit: "objects", kind: "gauge", resetType: "none", resetAnchor: null, resetTimezone: "UTC", staleAfterHours: 72 },
    ],
  },
  {
    id: "demo",
    name: "デモ(ローカル確認用)",
    description: "外部 API を呼ばずに架空の値を返します。自動取得・失敗・自動停止の動作確認用です。",
    caveats: ["ローカル開発専用。本番では表示されません。"],
    docsUrl: "https://github.com/",
    devOnly: true,
    backfill: "架空の過去分(当月 1 日〜昨日)を作ります。",
    fields: [
      { key: "mode", label: "動作(ok / fail)", secret: false, placeholder: "ok", help: "fail にすると毎回失敗します" },
      { key: "token", label: "ダミートークン", secret: true, placeholder: "何でもよい" },
    ],
    metrics: [
      { key: "demo-requests", label: "デモ リクエスト数", unit: "requests", kind: "cumulative", resetType: "monthly", resetAnchor: 1, resetTimezone: "UTC" },
    ],
  },
];

export const collectorMeta = (id: string | null | undefined) => COLLECTORS.find((c) => c.id === id);
