# サービス別 使用量取得方法の調査メモ

最終調査日:2026-11-22(公式ドキュメントの検索結果に基づく)

> 各サービスの無料枠・API 仕様は頻繁に変わります。本アプリでは **上限値をコードにハードコードせず、ユーザーが入力・編集する** 方針です。
> 下表の「要検証」は、実アカウントで疎通確認するまで断定しない項目です。確認したら日付と結果を追記してください。

凡例:◎ 公式 API で自動取得可 / △ 一部のみ・要検証 / × 公開 API なし(手動入力)

## 一覧

| サービス | 判定 | 自動取得できる情報 | 手動入力が必要な情報 |
|---|---|---|---|
| GitHub Actions | ◎ | 当期の Actions 使用分数(SKU 別) | 無料枠の分数(プランにより異なる) |
| Cloudflare Workers | ◎ | 日別リクエスト数 | 上限(Free は 10万/日と記載) |
| AWS S3 | △ | バケット容量・オブジェクト数(CloudWatch, 日次) | リクエスト数、無料枠(制度変更あり) |
| Supabase | △ | API リクエスト数、DB サイズ(SQL) | Egress・MAU 等の組織単位使用率 |
| Vercel | △ | (要検証)請求・使用量データ | Hobby で API 不可なら全て手動 |
| Claude API (Console) | △ | 使用量・コスト(Admin キー) | 個人アカウントで Admin キー発行可否 |
| Claude Pro / Max | × | なし | 5時間枠・週次枠の使用状況 |
| OpenAI API | ◎ | 使用量・コスト(Admin キー) | プリペイド残高 |
| Google Drive | ◎ | 使用容量・上限(bytes) | なし(OAuth の再認可は必要になり得る) |

## 詳細

### GitHub Actions
- **2026-11-22 追加調査**:`/usage` のページ冒頭には「ユーザー向けエンドポイントは個人で購入した Copilot の使用量を返す」とあり、**Actions の分数が含まれるかは明記されていない**。`/usage` は「enhanced billing platform を利用できるユーザーのみ」。
- 集計エンドポイント `GET /users/{username}/settings/billing/usage/summary`(パブリックプレビュー):`year` / `month`(既定は当月)/ `day` / `repository` / `product`(大文字小文字を区別しない)/ `sku`。応答の `usageItems[]` は `product, sku, unitType, pricePerUnit, grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity, netAmount`。過去 24 か月まで。
- **実装**:`/usage/summary?product=actions` を呼び、404 なら `/usage?year&month` に切り替える。`product` が actions かつ `unitType` に minute を含むものの数量を合計して分数とし、`netAmount` の合計を超過料金とする。
- 新課金基盤:`GET /users/{username}/settings/billing/usage`。`product = actions` かつ `unitType = minutes` の `quantity` を合計して分数を得る。金額は `netAmount`(有料分)/ `discountAmount`(無料枠分)。
- 旧 API:`GET /users/{username}/settings/billing/actions`(レガシー。classic PAT は `user` スコープ)。
- 最新 REST API バージョン表記:2026-03-10(個人アカウント向けの例は 2022-11-28 のものしか確認できず)。
- **確認済み(2026-11-22)**:fine-grained PAT は Account permissions の「Plan: Read-only」が必要(無いと 403)。`/usage/summary` で Actions の分数を取得できる。
- **要検証**:旧 API の廃止時期。
- 出典:<https://docs.github.com/rest/billing/enhanced-billing> , <https://docs.github.com/en/rest/billing/usage> , <https://docs.github.com/en/enterprise-cloud@latest/billing/managing-your-billing/automating-usage-reporting>

### Cloudflare Workers
- GraphQL Analytics API で Workers の呼び出し数を日別に集計(`workersInvocationsAdaptive` 等のデータセット)。
- GraphQL API のレート制限:既定 1 req/s(5分あたり 300 req)。
- Workers Free:1日 100,000 リクエスト、UTC 0時リセット。超過時 Error 1027。
- **2026-11-22 追加調査**:公式チュートリアルの例は `POST https://api.cloudflare.com/client/v4/graphql`、データセット `workersInvocationsAdaptive`、フィルタ `datetime_geq` / `datetime_leq` / `scriptName`、集計 `sum { requests errors subrequests }`。変数の型は `string`。トークンは Account → Account Analytics → Read。「3 か月前までの日付について最大 1 か月分」を照会できる。
- **実装**:当日 UTC 0 時〜現在の範囲で、スクリプトを絞らずに `sum.requests` を合計する。
- **要検証**:スクリプト指定なしで全スクリプトが返るか、Pages Functions のリクエストが含まれるか。
- 出典:<https://developers.cloudflare.com/workers/platform/limits/> , <https://developers.cloudflare.com/analytics/graphql-api/limits/> , <https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/>

### AWS S3
- CloudWatch `AWS/S3` 名前空間の `BucketSizeBytes`(日次・統計は Average)、`NumberOfObjects`。`BucketSizeBytes` はバージョンや未完了マルチパートも含むためコンソール表示より大きくなることがある。
- リクエスト数は S3 リクエストメトリクス(有料設定)が必要 → 本アプリでは手動入力扱い。
- Cost Explorer API はリクエスト課金があるため使用しない。
- **要検証**:AWS Free Tier API(`GetFreeTierUsage`)の利用可否・応答 / 現行の AWS 無料枠制度 / CloudWatch API 呼び出しの無料範囲。
- 出典:<https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html> , <https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudwatch-monitoring-accessing.html>

### Supabase
- Management API:`/v1/projects/{ref}/analytics/endpoints/usage.api-counts` 等。細粒度トークンには `analytics_usage_read` が必要。`usage.api-requests-count` は 30 req/min、全体は 120 req/min。
- DB サイズは SQL(`pg_database_size`)で取得可能。
- Free プラン:クォータは組織単位、アクティブプロジェクト 2つまで、DB 0.5GB/プロジェクト。**1週間データベース活動がないと一時停止**。
- **要検証**:組織の使用率(Egress, MAU, Storage)を API で取得できるか(OpenAPI 仕様 `api.supabase.com/api/v1-json` を確認)。
- 出典:<https://supabase.com/docs/reference/api/introduction> , <https://supabase.com/docs/guides/platform/billing-on-supabase> , <https://supabase.com/docs/guides/platform/project-pausing>

### Vercel
- `GET https://api.vercel.com/v1/billing/charges?teamId=...`:FOCUS v1.3 形式、日次粒度、最大1年、JSONL ストリーム。
- CLI:`vercel billing usage`(人手確認用)。
- **要検証**:Hobby プラン(個人)で `/billing/charges` が使えるか。使えなければ手動入力。
- 出典:<https://vercel.com/changelog/access-billing-usage-cost-data-api> , <https://vercel.com/docs/rest-api/billing/list-focus-billing-charges> , <https://vercel.com/docs/cli/usage>

### Claude
- **API(Console)**:Usage & Cost Admin API。Admin API キー(`sk-ant-admin...`)が必要で、組織の admin のみ発行可。新規連携は「Usage and Cost Analytics API」を推奨とする記載もある。
- **Pro / Max(claude.ai / Claude Code)**:5時間セッション枠と週次枠。公開 API なし → 手動入力(リセット方式:ローリング / 週次)。
- **要検証**:個人アカウントでの Admin キー発行可否、推奨 API の最終形。
- 出典:<https://platform.claude.com/docs/en/manage-claude/usage-cost-api> , <https://support.claude.com/en/articles/8324991-about-claude-s-pro-plan-usage> , <https://support.claude.com/en/articles/11014257-about-claude-s-max-plan-usage>

### OpenAI API
- Usage API(completions / embeddings / images 等)と Costs API(`/v1/organization/costs`)。**Admin キー**が必要(通常の API キーでは不可)。
- プリペイド残高は公式 API で取得できない → 手動入力。
- **2026-11-22 追加調査**:`GET https://api.openai.com/v1/organization/costs`。`start_time`(Unix 秒、必須)、`end_time`、`bucket_width`(Costs は `1d` のみ)、`limit`(既定 7、1〜180)、`page`(前回の `next_page`)、`group_by`、`project_ids` など。応答は `data[]`(バケット)→ `results[]` → `amount { value, currency }`(通貨は小文字の ISO 4217、例 `usd`)、`has_more`、`next_page`。料金確定までの遅延は記載なし。
- **実装**:当月 1 日 0 時(UTC)から `limit=31` で取得し、ページをたどって `amount.value` を合計。USD 以外が含まれたらエラー。
- 出典:<https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage> , <https://developers.openai.com/cookbook/examples/completions_usage_api>

### Google Drive
- Drive API v3 `about.get`(`fields=storageQuota`):`limit`, `usage`, `usageInDrive`, `usageInDriveTrash`(すべて bytes)。無制限の場合 `limit` は欠落。組織のプール容量の場合は組織全体の値。
- `about.get` は読み取り系(5 quota units)。
- OAuth2(refresh token をサーバー側に暗号化保存)。
- **要検証**:OAuth 同意画面が「テスト」状態のときの refresh token 有効期限、最小スコープ。
- 出典:<https://developers.google.com/workspace/drive/api/reference/rest/v3/about> , <https://developers.google.com/workspace/drive/api/guides/limits>

## 本アプリのホスティング先(Cloudflare)の無料枠

| 項目 | Free の記載値 | 本アプリの想定使用量 |
|---|---|---|
| Workers リクエスト | 100,000 / 日 | 数百 / 日 |
| Workers CPU 時間 | 10ms / リクエスト | 外部 API 待ちは含まれないため通常問題なし |
| Cron Triggers | 5(アカウント単位との記載。ドキュメント間で不一致あり→要検証) | 1 |
| D1 ストレージ | 500MB / DB、5GB / アカウント | 約 10MB / 年 |
| D1 行読み取り | 5,000,000 / 日 | 数千〜数万 / 日 |
| D1 行書き込み | 100,000 / 日 | 約 150 / 日 |

出典:<https://developers.cloudflare.com/d1/platform/limits/> , <https://developers.cloudflare.com/d1/platform/pricing/> , <https://developers.cloudflare.com/workers/configuration/cron-triggers/>

## 検証ログ

| 日付 | サービス | 確認内容 | 結果 |
|---|---|---|---|
| 2026-11-22 | GitHub Actions | 個人アカウント + fine-grained トークンで「今すぐ取得」 | 成功。当月の Actions 分数(108 minutes)を取得できた。ユーザー向けエンドポイントに Actions が含まれることを確認。GitHub の Billing 画面の値との一致は未確認 |
| 2026-11-22 | GitHub Actions | 本番(Cloudflare)で権限なしの fine-grained トークン | HTTP 403「Resource not accessible by personal access token」。Account permissions の **Plan: Read-only** を付けると成功。→ 必要な権限は Plan: Read-only と確定 |
| 2026-11-22 | Discord 通知 | 本番で Webhook URL を保存し「テスト送信」 | 成功。指定チャンネルにテスト通知が届いた |
| 2026-11-23 | AWS S3 | 本番で専用 IAM ユーザー(`cloudwatch:GetMetricStatistics` のみ)のキーを登録し「今すぐ取得」 | 成功。AWS Query / XML 形式で使用容量とオブジェクト数を取得できた。1 サービス = 1 バケット |
| 2026-11-23 | Cloudflare Access | 本番(workers.dev)を Self-hosted アプリで保護 | ログインなしのトップページ・API はログイン画面へリダイレクト(302)、偽トークンも拒否。メールのコードでログインできることを確認 |

## 実装状況(第3段階)

| コレクター ID | 状態 | テスト | 実アカウント検証 |
|---|---|---|---|
| `github-actions` | 実装済み | 偽の応答で確認(集計、404 時の切り替え) | **済**(ローカル・本番、2026-11-22) |
| `cloudflare-workers` | 実装済み | 偽の応答で確認(合計、GraphQL エラー、アカウントなし) | 未 |
| `openai-costs` | 実装済み | 偽の応答で確認(ページ送り、USD 以外) | 未 |
| `google-drive` | 実装済み | 偽の応答で確認(トークン更新、上限なし、失効) | 未 |
| `aws-s3` | 実装済み | 偽の応答で確認(クエリ、XML 解析、署名、データなし、403) | **済**(本番、2026-11-23) |
| Supabase / Vercel / Claude | 手動入力(Supabase・Vercel は将来候補) | — | — |

実アカウントで確認したら、上の「検証ログ」に日付・結果を書き、この表の「実アカウント検証」を更新してください。

## 第4段階の追加調査(2026-11-22)

### AWS S3(コレクター `aws-s3` を実装)
- S3 の日次ストレージメトリクス(`BucketSizeBytes` / `NumberOfObjects`)は「1 日 1 回報告され、追加料金なしで提供」と記載。統計は Average のみ。`BucketSizeBytes` の `StorageType` は `StandardStorage` など、`NumberOfObjects` は `AllStorageTypes`。
  出典:<https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudwatch-monitoring.html> , <https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html>
- CloudWatch の無料枠は「100 万 API リクエスト(GetMetricData・GetInsightRuleReport・GetMetricWidgetImage を除く。この 3 つは常に課金)」。→ **GetMetricStatistics を使う**(1 日 4 回 × 2 指標 ≒ 月 240 回)。GetMetricStatistics の単価は料金ページから読み取れず未確認。
  出典:<https://aws.amazon.com/cloudwatch/pricing/>
- GetMetricStatistics:Period は 15〜63 日前なら 300 の倍数など。1 回 1,440 点まで。データ点は時系列順とは限らない。
  出典:<https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricStatistics.html>
- 通信形式(AWS Query プロトコル、`Action=GetMetricStatistics&Version=2010-08-01`、応答 XML)は API リファレンスに明記なし。偽のキーで `InvalidClientTokenId` の XML が返ることを確認(2026-11-22)し、実キーで値を取得できることも確認(2026-11-23)。
- 1 サービスで 1 バケット。AWS の無料枠はアカウント全体の合計にかかるため、複数バケットを合計する機能は将来候補。
- 無料プラン(新方式):「$100 のクレジット、6 か月で最大 $200」。「6 か月後またはクレジットを使い切った時点の早いほうで終了」。終了後は**アカウントが自動で閉じられ**、データは 90 日保持(その間に有料プランへ切り替えれば復元)。有料プランはクレジットがなくなっても閉じない。
  出典:<https://aws.amazon.com/free/> , <https://aws.amazon.com/free/free-tier-faqs/> , <https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html>
- 旧方式(12 か月無料枠)の終了後の扱いと、S3 の無料枠容量(5 GB など)は今回読んだページに記載なし → 自分の請求ダッシュボードで確認。
- 無料枠の使用量 API:`GetFreeTierUsage` / 残り日数は `GetAccountPlanState`(Free Tier API、`freetier-2023-09-07`)。エンドポイント・署名名・IAM 権限は未確認。**将来、無料期間の終了日の自動入力に使える候補。**
  出典:<https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_Operations_AWS_Free_Tier.html>

### 将来候補(手動入力のまま)
- **Supabase**:Personal Access Token はアカウントの全プロジェクトを操作できる強い権限。DB サイズを SQL で取ると DB の活動として扱われ、無料プランの自動一時停止を防ぐ副作用がありうる(要確認)。組織単位の Egress・MAU は API で取れるか未確認。
- **Vercel**:Hobby で `/v1/billing/charges` が使えるか未確認。トークンはアカウント全体の権限を持つ。応答は JSONL。
- **Claude Pro / Max**:公開 API なし。
