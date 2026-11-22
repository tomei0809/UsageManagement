# UsageManagement 設計書(v0.1 / 2026-11-22 確定)

## Context
複数サービス(GitHub Actions / Cloudflare / AWS S3 / Supabase / Vercel / Claude / OpenAI / Google Drive …)の無料枠・利用量を一画面で把握し、上限超過を事前に察知したい。各サービスで上限・単位・リセット方式・取得手段がバラバラなため、**サービス非依存の汎用データモデル + サービス別「コレクター」プラグイン**で吸収する。運用は原則無料・常時起動サーバーなし。
本計画承認後の最初の成果物は **README.md(公開用)/ CLAUDE.md(個人用・.gitignore)/ docs/ 配下の設計資料** と第1段階の実装。

> 注意:以下の無料枠・API仕様は 2026-11 時点の公式ドキュメント検索結果に基づく。「要検証」は実アカウントでの疎通確認まで断定しない項目。数値はアプリ内でハードコードせず、ユーザーが上限値を入力/編集できる設計にする(仕様変更への耐性)。

---

## 1. 要件整理と MVP

| 区分 | 機能 | 段階 |
|---|---|---|
| **MVP** | サービス/メトリクスの登録・編集・削除、上限・単位・リセット方式の設定 | 1 |
| **MVP** | 使用量の手動入力(入力のたびにスナップショットとして保存=履歴の土台を最初から作る) | 1 |
| **MVP** | 使用率・残量の計算、横棒グラフのダッシュボード、取得方法バッジ(API/手動/推定)、最終更新日時、「古いデータ」表示 | 1 |
| 第2段階 | 日別・月別グラフ、閾値(注意80/警告95/上限100、メトリクス別に変更可)、リセット日管理と次回リセット日表示 | 2 |
| 第3段階 | Cron による自動取得(GitHub → Cloudflare → OpenAI → Google Drive の順)、失敗記録・リトライ・失敗表示 | 3 |
| 第3段階 | **定期チェックの停止/再開**(全体・サービス単位・メトリクス単位、期限付き一時停止、停止中表示)→ §6.1 | 3 |
| 第4段階 | 超過予測(線形+日次ペース)、Discord Webhook 通知、料金(金額)メトリクス、サービス拡充 | 4 |

MVP の判断基準:「手動入力だけでも毎日使える」こと。自動取得は後付けでも同じテーブルにデータが入るため、MVP 段階で履歴テーブル(snapshots)を作っておく。

## 2. サービス別 取得可否調査(要点)

凡例:◎ 公式APIで自動取得可 / △ 一部のみ・要検証 / × API無し→手動

| サービス | 取得手段(公式) | 認証 | 判定 | 手動が必要な情報・注意 |
|---|---|---|---|---|
| GitHub Actions | 新課金基盤 `GET /users/{username}/settings/billing/usage`(product=actions, unit=minutes の quantity を集計)。旧 `/settings/billing/actions` はレガシー | PAT(必要権限は要検証) | ◎ | 無料枠分数はプランで変わる→上限はユーザー入力。金額ベース返却なので分への換算ロジック要 |
| Cloudflare Workers | GraphQL Analytics API(Workers 呼び出し数を日別集計)。GraphQL は既定 1 req/s・300 req/5min | API Token(Account Analytics Read) | ◎ | Free は 10万 req/日・UTC 0時リセット(=**日次リセット**の例) |
| AWS S3 | CloudWatch `BucketSizeBytes`/`NumberOfObjects`(日次・Average)。Free Tier API(`GetFreeTierUsage`)は**要検証**。Cost Explorer API は有料のため使わない | IAM アクセスキー(読取専用・最小権限)+SigV4署名 | △ | リクエスト数メトリクスは有料のリクエストメトリクス設定が必要。AWS 無料枠制度自体が近年変更されているため上限は手動入力 |
| Supabase | Management API の analytics(API リクエスト数、30 req/min 制限)。DB サイズは SQL(`pg_database_size`)で取得可 | Personal Access Token / 細粒度トークン | △ | 組織単位の使用率(Egress, MAU 等)を API で返すかは未確認→手動。**Free は1週間無活動で一時停止**される点に注意 |
| Vercel | `/v1/billing/charges`(FOCUS形式・日次粒度)。**Hobby で使えるかは未確認** | Vercel Token | △ | 使えなければ手動。CLI `vercel billing usage` は人手確認用 |
| Claude (API/Console) | Usage & Cost Admin API(新規は Usage and Cost Analytics API 推奨との記載あり→要検証) | Admin API キー `sk-ant-admin…`(組織 admin のみ発行可) | △ | 個人アカウントで Admin キーが発行できるかは要確認 |
| Claude (Pro/Max) | 公開APIなし | – | × | 5時間セッション枠・週次枠は**手動入力**(リセット方式=ローリング) |
| OpenAI API | Usage API / Costs API(`/v1/organization/costs` 等) | Admin キー | ◎ | プリペイド残高は公式APIで取得不可→手動 |
| Google Drive | Drive API `about.get` の `storageQuota`(bytes、`limit` は無制限時に欠落) | OAuth2(refresh token 保存) | ◎ | OAuth 同意画面が「テスト」状態だと refresh token が短期失効する(要確認)→再認可導線が必要 |

調査結果の全文・出典・要検証リストは `docs/services.md` に記録し、各コレクター実装時に実アカウントで疎通確認してから「要検証」を外す。

## 3. 無料ホスティング/定期実行/DB 比較

| 構成 | 定期実行 | DB | 長所 | 短所 |
|---|---|---|---|---|
| **A. Cloudflare Workers + D1 + Cron Triggers(推奨)** | Cron Triggers(Free でも可、数に上限あり) | D1(SQLite, Free: 500MB/DB・5M行読取/日・10万行書込/日) | 1プラットフォームで完結、休止なし、Secrets 管理あり、無料枠に対して本アプリの負荷が桁違いに小さい | Free の CPU 10ms/リクエスト(I/O 待ちは含まない。外部API呼び出し主体なので通常問題なし)、Node 互換に一部制約 |
| B. Vercel (Next.js) + Supabase | Vercel Cron(Hobby は頻度制限あり・要確認) | Supabase Postgres(Free 0.5GB) | Next.js エコシステム、Postgres | **Supabase Free は1週間無活動で停止**、2サービスにまたがる、監視対象自身に依存 |
| C. 静的サイト + GitHub Actions(cron) + JSON/SQLite をリポジトリ保存 | GitHub Actions schedule | リポジトリ内ファイル | ほぼ設定不要 | 手動入力UIが作りにくい、Actions 分数を自分で消費、秘密情報の扱いが難しい |
| D. ローカル PC のみ(Docker/SQLite) | OS のタスクスケジューラ | SQLite | 完全無料・秘密情報が外に出ない | PC 起動中のみ、スマホから見られない |

推奨は A。理由:①常時起動不要でCronがある ②DB・秘密情報・ホスティングが同一アカウントで完結 ③Free 枠に対する負荷が 0.1% 未満(§7)④自分の Cloudflare 使用量も同じ GraphQL API で監視できる。

## 4. 技術スタック(案Aの場合)と選定理由

- **バックエンド: Hono(TypeScript) on Cloudflare Workers** — Workers ネイティブで軽量、ルーティング+バリデーション(zod)が最小構成で書ける。Express 等は Workers 非前提。
- **フロント: React + Vite(SPA)を Workers Static Assets で配信** — 管理画面は SEO/SSR 不要。SPA で十分かつ Free の CPU 制限に対して SSR しない方が有利。グラフは **Recharts**(横棒・折れ線・積み上げが揃う)。
- **DB: D1 + Drizzle ORM(マイグレーションは SQL ファイル管理)** — 型安全なクエリとスキーマ定義を共有型として front/back で使える。
- **認証(アプリへのアクセス制御): Cloudflare Access(Zero Trust 無料枠)** でアプリ全体を保護 → アプリ側にログイン実装不要。代替:単一パスワード+署名付き Cookie。
- **テスト: Vitest + @cloudflare/vitest-pool-workers**(D1 をローカル Miniflare で実行)。計算ロジックは純粋関数で単体テスト。
- **言語統一: TypeScript 単一言語**(コレクター・計算ロジックをフロントでも再利用:使用率・予測の表示計算)。

## 5. システム構成

```
[Browser SPA] --HTTPS--> [Cloudflare Access] --> [Worker (Hono)]
                                                   ├─ /api/*  CRUD・手動入力・集計
                                                   ├─ static assets (React)
                                                   └─ scheduled() ← Cron Triggers (例: 6時間ごと)
                                                         └─ collectors/registry → 各サービスAPI
                                                   [D1]  services / metrics / snapshots / runs ...
                                                   [Secrets] 暗号化マスターキー・固定トークン
                                          (第4段階) → Discord Webhook
```

コレクターはプラグイン方式:
```ts
interface Collector {
  id: 'github-actions' | 'cloudflare-workers' | ...;
  credentialFields: CredentialFieldDef[];          // UI が入力フォームを自動生成
  collect(ctx: { creds; metric; period; fetch }): Promise<Reading[]>;  // Reading = {metricKey, value, unit, periodStart, raw?}
}
```
サービス仕様変更時は該当コレクター1ファイルのみ修正。`raw` に API 応答の要約を保存し、仕様変化の検知・デバッグに使う。

## 6. データ設計(サービス非依存)

核心:**「サービス」ではなく「メトリクス」を単位にする**(Supabase は DB容量・Egress・MAU など複数指標を持つため)。

```
services        id, name, category, url, notes, created_at
metrics         id, service_id, key, label, unit(例 'minutes','requests','bytes','USD'),
                kind      'cumulative'(期間内に積み上がる: Actions分, リクエスト数, 料金)
                        | 'gauge'(その時点の量: ストレージ容量, DBサイズ),
                limit_value (NULL=無制限), 
                reset_type 'monthly'|'daily'|'weekly'|'rolling'|'billing_cycle'|'none',
                reset_anchor (例: 毎月1日 / 契約日 / ローリング時間数), reset_timezone ('UTC' 等),
                collector_id (NULL=手動のみ), stale_after_hours, enabled
thresholds      metric_id, level('caution'|'warning'|'limit'), percent   ※既定 80/95/100
snapshots       id, metric_id, value, period_start, period_end, collected_at,
                source 'api'|'manual'|'estimate', collector_run_id, note
collector_runs  id, collector_id, service_id, started_at, finished_at,
                status 'success'|'partial'|'failed', error_message
credentials     id, service_id, collector_id, ciphertext, iv, created_at, rotated_at
alerts (第4段階) id, metric_id, level, triggered_at, notified_at, channel
```

- 現在値 = そのメトリクスの「現在期間」の最新 snapshot。期間は reset_type から計算する純粋関数 `currentPeriod(metric, now)` で決定。
- 使用率 = value / limit_value。単位変換(bytes→GB 等)は表示層のみ。
- 「古いデータ」= `now - collected_at > stale_after_hours`、「取得失敗」= 最新 collector_runs.status。
- 予測値は snapshots に `source='estimate'` として保存せず、表示時に計算(実測と混同しない)。推定取得値のみ estimate で保存。
- 有料サービス拡張:unit='USD' のメトリクス+ limit_value=予算 で同一の仕組みに乗る。

### 6.1 定期チェックの停止/再開機能
停止を3階層で持ち、Cron ハンドラは実行前に必ず判定する(上位が停止なら下位は実行しない)。

```
app_settings    key, value          例: scheduler_enabled='true', notifications_enabled='true'
services        + polling_enabled (bool), paused_until (NULL=無期限 or 日時), pause_reason
metrics         + polling_enabled (bool), poll_interval_hours (NULL=全体設定に従う)
```

- **全体停止**:設定画面のトグル1つで全コレクターの定期実行を停止(Cron 自体は起動するが即 return。D1 読取1回のみで無料枠への影響は無視できる)。通知も独立トグルで停止可。
- **サービス/メトリクス単位の停止**:例「Vercel を解約したので取得停止」「Supabase の Egress だけ止める」。
- **期限付き一時停止**:`paused_until` を過ぎると自動で再開(例:API 仕様変更で失敗が続く間 7日停止)。
- **自動停止(サーキットブレーカー)**:同一コレクターが N 回連続失敗したら自動で一時停止し、ダッシュボードに理由を表示(API 制限やトークン失効時に無駄な呼び出しを続けない)。
- **手動実行**:停止中でも「今すぐ取得」ボタンで単発実行可能。
- 停止中のメトリクスはダッシュボードで「⏸ 停止中」バッジ+最終取得日時を表示し、古いデータ警告とは区別する。手動入力は停止中でも可能。
- **完全停止(プラットフォーム側)**:アプリを使わなくなった場合は `wrangler.jsonc` の `triggers.crons` を空にしてデプロイ(または Cloudflare ダッシュボードで Cron Trigger 削除)で Worker の定期起動そのものを止める。手順を README に記載。
- 停止/再開の操作は `app_events`(操作ログ)に記録。

## 7. データ量・容量見積もり

前提:10サービス × 平均3メトリクス=30メトリクス、Cron 6時間ごと(1日4回)。
- snapshots:30 × 4 = **120行/日 ≒ 4.4万行/年**、1行 ≒ 150–250B(索引込み) → **約10MB/年**
- collector_runs:8サービス × 4 = 32行/日 ≒ 1.2万行/年(<3MB/年)。手動入力分は誤差。
- 10年運用でも 100–150MB 程度 → D1 Free 500MB/DB に収まる。必要なら 1年超の snapshots を日次1行に間引く(ロールアップ)で 1/4 に。
- D1 書込:約150行/日(Free 10万/日の0.15%)。読取:ダッシュボード表示1回あたり数百〜数千行(索引設計で抑制)→ 5M/日に対し十分。
- 外部API呼び出し:各サービス1日4回程度 → いずれのレート制限にも余裕。

## 8. 認証情報の管理

1. アプリ自体:Cloudflare Access で本人のみアクセス可。
2. 固定のトークン(MVP〜第3段階):`wrangler secret put` で Workers Secrets に保存。コード・Git・D1 に平文で置かない。
3. UI から追加するトークン(第3段階後半):D1 に **AES-GCM で暗号化して保存**、マスターキーは Workers Secret。API は値を返さず「設定済み/末尾4文字」だけ表示。
4. 最小権限:各サービスで読み取り専用・最小スコープのトークンを発行(AWS は CloudWatch 読取のみの IAM ユーザー等)。README に発行手順と推奨スコープを記載。
5. `.dev.vars` / `.env*` / `CLAUDE.md` を `.gitignore`。

## 9. ファイル構成(案)

```
UsageManagement/
├─ README.md                 # 公開用:概要・機能・技術構成・セットアップ・デプロイ・各サービストークン発行手順
├─ CLAUDE.md                 # 個人用開発メモ(.gitignore)
├─ .gitignore  .dev.vars.example  wrangler.jsonc  package.json  tsconfig.json  vite.config.ts
├─ docs/
│  ├─ design.md              # 本設計の確定版
│  └─ services.md            # サービス別調査結果・出典・要検証チェックリスト
├─ migrations/0001_init.sql
├─ src/
│  ├─ shared/                # front/back 共通
│  │  ├─ schema.ts           # Drizzle スキーマ + 型
│  │  ├─ period.ts           # currentPeriod / nextResetAt
│  │  └─ usage.ts            # 使用率・残量・状態判定・予測(純粋関数)
│  ├─ worker/
│  │  ├─ index.ts            # Hono app + scheduled()
│  │  ├─ routes/{services,metrics,snapshots,dashboard}.ts
│  │  ├─ collectors/{registry,github-actions,cloudflare-workers,openai,google-drive,...}.ts
│  │  └─ lib/{crypto,db}.ts
│  └─ web/
│     ├─ main.tsx  App.tsx
│     ├─ pages/{Dashboard,ServiceDetail,ServiceEdit}.tsx
│     └─ components/{UsageBar,SourceBadge,StaleBadge,HistoryChart}.tsx
└─ test/{usage,period}.test.ts, api.test.ts
```

## 10. 開発工程

1. **第1段階**:プロジェクト初期化(wrangler + Vite + Hono + Drizzle)、README/CLAUDE.md/docs 作成、D1 スキーマ、サービス/メトリクス CRUD、手動入力、ダッシュボード(横棒・バッジ・古さ表示)、Access 設定手順
2. **第2段階**:period.ts でリセット計算、履歴グラフ(日別/月別)、閾値設定UI と色分け警告
3. **第3段階**:Cron + collector registry、GitHub Actions → Cloudflare → OpenAI → Google Drive(OAuth)、collector_runs と失敗表示、指数バックオフ
4. **第4段階**:予測(直近N日の平均ペース→期末推定、実測と破線で区別)、Discord Webhook、Supabase/Vercel/AWS/Claude Admin コレクター、料金メトリクス

## 11. 検証方法
- `npm run test`(Vitest):usage.ts / period.ts の境界値(上限NULL、日次UTCリセット、月末、ローリング)
- `wrangler dev` でローカル D1 に対し CRUD・手動入力・ダッシュボード表示を確認
- 第3段階:`wrangler dev --test-scheduled` で `/__scheduled` を叩きコレクター実行、失敗時に collector_runs に記録されること
- 停止機能:全体停止/サービス停止/メトリクス停止/期限切れ自動再開/連続失敗での自動停止 の各ケースで、Cron 実行時に外部 API が呼ばれない(または呼ばれる)ことを Vitest(fetch モック)で確認
- 各コレクターは実アカウントで疎通し、docs/services.md の「要検証」を更新

## 12. 決定事項(2026-11-22 ユーザー回答)
- ホスティング:**A. Cloudflare Workers + D1 + Cron Triggers**
- 利用者:**自分専用**(テーブルに user_id を持たない。将来の複数ユーザー化はマイグレーションで追加)
- アクセス保護:**Cloudflare Access**(Worker 側でも `Cf-Access-Jwt-Assertion` を検証して二重化)
- 自動取得頻度:**6時間ごと**(cron `0 */6 * * *`、メトリクス単位で間隔を上書き可能な設計)

## 13. 承認後に最初に行う作業
1. `git init`、`.gitignore`(CLAUDE.md, .dev.vars, node_modules, .wrangler)
2. README.md(第三者向け:目的・機能・取得方式の区別・技術構成・セットアップ/デプロイ・Access 設定・トークン発行手順・無料枠の注意)
3. CLAUDE.md(個人用:コマンド、規約、要検証リスト、意思決定ログ)
4. docs/design.md(本計画の確定版)、docs/services.md(§2 の調査結果+出典URL+要検証チェックリスト)
5. 第1段階の実装に着手

## 14. 実装時の変更点(第1段階)
- 閾値は `thresholds` テーブルではなく `metrics.caution_pct` / `metrics.warning_pct` 列で保持(100% = 上限到達は固定)。通知チャネル別の閾値が必要になったらテーブル化する。
- リセット方式 `billing_cycle` は `monthly` + `reset_anchor`(契約日)で表現できるため廃止。
- Drizzle スキーマは `src/worker/db/schema.ts`(フロントは drizzle に依存せず `src/shared/types.ts` の API 型を使う)。
- 状態計算は `src/shared/status.ts`(`buildMetricStatus` / `latestSince`)。
- 画面遷移は依存を増やさないためハッシュルーター(`src/web/router.ts`)。Recharts はグラフを使う第2段階で導入。
- 停止機能用の列(`polling_enabled`, `paused_until`, `pause_reason`, `poll_interval_hours`)と `collector_runs` / `app_settings` / `app_events` は初回マイグレーションに含めた。

## 15. 第2段階の実装メモ
- API: `GET /api/metrics/:id/series?granularity=day&days=30`(7〜400) / `?granularity=month&months=12`(1〜36)。範囲内の記録と、範囲直前の 1 件を読む(先頭の差分を正しく求めるため)。
- 集計(`src/shared/series.ts`):累積型(cumulative かつ rolling 以外)は記録ごとの増加量 = 同じ期間内の前回値との差分(負なら 0)、期間が変わったら値そのもの。日別は増加量の合計と、その日の最後の値。月別は monthly リセットならリセット期間ごと、それ以外は暦月。gauge と rolling は最後の値。
- 既知の制約:記録を始めた日の増加量には期間開始からの累計が含まれる(画面に注記)。値を下方修正した記録は増加 0 として扱う。
- 表示:dataviz の方針に従い、2つの量は別グラフ(二軸にしない)、上限は破線と文字、リセット日は縦の点線と文字、ツールチップ、表表示。

## 16. 第3段階の実装メモ
- コレクター = `shared/collectors.ts`(入力項目・指標ひな形・注意事項のメタデータ)+ `worker/collectors/<id>.ts`(取得処理)+ `registry.ts`。取得値は指標の `key` で対応づける。
- 接続はサービス単位(`services.collector_id` / `collector_config`)。秘密情報は `credentials` に AES-256-GCM で暗号化(鍵は Secret `MASTER_KEY`、IV は毎回ランダム)。API は値を返さず末尾 4 文字のヒントのみ。
- 停止の判定は `shared/schedule.ts` の `pollState`:全体(`app_settings.scheduler_enabled`)> サービス(`polling_enabled=false` で無期限、`paused_until` で期限付き)> バックオフ(`next_run_at`)。指標単位は `metrics.polling_enabled`。全指標が停止中のサービスは API を呼ばない。
- 失敗時:その場で 429/5xx/通信エラーを 2 回まで再試行(0.5s, 1.5s。Retry-After が 10 秒超なら待たない)。定期実行の間隔は 1 回目の失敗は通常どおり、以降 12h → 24h → 48h。連続 N 回(既定 5)で自動停止(Cron 実行時のみ。「今すぐ取得」では自動停止しない)。再開すると失敗回数とバックオフをリセット。
- 変更点:計画にあった「指標ごとの取得間隔(`poll_interval_hours`)」は実装していない(列のみ残置)。Cron が 6 時間ごとで、サービス単位の停止・一時停止で十分と判断。
- Google Drive は API が返す上限で `metrics.limit_value` を自動更新する(上限は API の値が正)。
- ローカル確認用に `demo` コレクター(`ENABLE_DEMO_COLLECTOR=true` のときだけ有効)。開発サーバーでは `/cdn-cgi/handler/scheduled?cron=...&time=<ms>` で Cron を疑似実行できる。

## 17. 過去分の補完(当月)
- コレクターの任意メソッド `backfill()` が、当月 1 日〜昨日(UTC)の各日の終わり時点の値(累積型なら月初からの累計)を返す。`POST /api/services/:id/backfill`。
- GitHub は `/usage/summary?year&month&day=N&product=actions` を 1 日ずつ呼ぶ(`day` は公式に「1 日分の結果だけを返す」と記載。`/usage` の `date` の形式は記載がないため使わない)。
- 範囲を当月に限る理由:Workers Free は 1 回の実行で外部へのリクエストが 50 まで。1 日 1 回 × 最大 30 日で収まる。
- 保存:`collected_at = YYYY-MM-DDT23:59:59.999Z`、`source = api`、`note = 過去分を補完`。再実行時は補完記録だけを削除して入れ直す(冪等)。手動入力・定期取得の記録がある日は上書きしない(`planBackfill`)。

## 18. 第4段階の実装メモ
- **予測** `shared/forecast.ts`:累積型は「直近 7 日内で最も古い記録」との差からペースを出す。当期開始から 7 日未満、または比較できる記録がなければ当期開始(値 0)から。最低経過時間は 1 日(日次リセットは 6 時間)。gauge は 7 日の増加から上限到達日(90 日以内)。保存しない。`lib/statuses.ts` の `loadDashboard` が指標ごとに比較用の記録を 1 クエリずつ読む(ダッシュボードと通知で共用)。
- **通知** `worker/notify.ts`:`decideAlerts`(純粋関数)→ Discord 送信 → `alerts` テーブルに記録(`kind, subject, period_key` で一意、level は通知済みの最高レベル)。レベルが ok に戻ったら記録を消す。累積型の超過見込みは 1 期間 1 回。送信失敗時は記録しない(次回再送)。通知オフ・Webhook 未設定でも記録は更新する(再開時に大量に届かないため)。呼び出し:Cron の最後(取得の全体停止中も実行)、手動入力・今すぐ取得・過去分補完の後(`waitUntil`)、自動停止時。
- **Webhook URL** は `app_settings.discord_webhook` に AES-GCM で暗号化して保存。Discord の Webhook URL 形式のみ受け付ける。`allowed_mentions: {parse: []}` でメンションを無効化。
- **無料期間** `services.free_tier_ends_at`(この日まで無料。終了時刻は翌日 0 時 UTC)、`pause_on_free_tier_end`(1 回使ったら false に戻す=再開を妨げない)。通知は 30 / 7 / 0 日の段階ごとに 1 回。
- **料金のまとめ**:単位 USD の指標を合計。新しいテーブルは作らない。
- **AWS S3**:`aws4fetch` で SigV4 署名し、GetMetricStatistics(Query / XML)を呼ぶ。GetMetricData は常に課金のため使わない。
- 通知文の日付は `TIMEZONE`(wrangler vars、既定 Asia/Tokyo)。

## 19. 本番運用の構成(2026-11-23)
- Cloudflare Workers(workers.dev)にデプロイ。Cron `0 */6 * * *`、D1 は本番用を別に作成(`database_id` は wrangler.jsonc)。
- 保護:Cloudflare Access の Self-hosted アプリ(宛先 = workers.dev のホスト名、ポリシー = 自分のメールのみ Allow、ログインは One-time PIN)。エッジで未ログインをログイン画面へリダイレクトし、Worker でも `Cf-Access-Jwt-Assertion`(チームドメインの公開鍵・AUD・期限・発行者)を検証する二重構え。
- プレビュー URL は `preview_urls: false` で無効(Access の宛先外の入口を作らない)。
- 秘密情報は Workers Secret の `MASTER_KEY` のみ。トークン・Webhook URL は D1 に暗号化して保存。
- 実アカウント確認済み:GitHub Actions(Plan: Read-only)、AWS S3(GetMetricStatistics)、Discord、Access。
