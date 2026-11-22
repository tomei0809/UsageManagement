export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** "false" のときのみ Access 検証を省略(ローカル開発用。.dev.vars で設定) */
  REQUIRE_ACCESS: string;
  /** 例: yourteam.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access アプリケーションの Application Audience (AUD) タグ */
  ACCESS_AUD: string;
  /** 秘密情報の暗号化鍵(base64 32 バイト)。Workers Secret で設定 */
  MASTER_KEY?: string;
  /** 通知文の日付に使うタイムゾーン(既定 Asia/Tokyo) */
  TIMEZONE?: string;
  /** "true" でデモ用コレクターを有効化(ローカル開発専用) */
  ENABLE_DEMO_COLLECTOR?: string;
}

export const allowDemo = (env: Env) => env.ENABLE_DEMO_COLLECTOR === "true";
