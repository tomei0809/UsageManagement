import { AwsClient } from "aws4fetch";
import { collectorMeta } from "../../shared/collectors";
import { fetchText, requireField } from "./http";
import { CollectorError, type Collector } from "./types";

/**
 * S3 の日次ストレージメトリクス(CloudWatch、名前空間 AWS/S3)を GetMetricStatistics で読む。
 * - S3 のストレージメトリクス自体は無料(1 日 1 回報告)
 * - GetMetricData は常に課金されるが、GetMetricStatistics は CloudWatch の無料 API リクエスト枠(月 100 万)の対象
 * - 通信形式は AWS Query プロトコル(応答 XML)。公式 API リファレンスには明記がないため実アカウントで要検証
 */
const STORAGE_TYPE = "StandardStorage";

export function buildQuery(region: string, bucket: string, metric: "BucketSizeBytes" | "NumberOfObjects", now: Date): string {
  const qs = new URLSearchParams({
    Action: "GetMetricStatistics",
    Version: "2010-08-01",
    Namespace: "AWS/S3",
    MetricName: metric,
    "Dimensions.member.1.Name": "BucketName",
    "Dimensions.member.1.Value": bucket,
    "Dimensions.member.2.Name": "StorageType",
    "Dimensions.member.2.Value": metric === "BucketSizeBytes" ? STORAGE_TYPE : "AllStorageTypes",
    // 1 日 1 回の報告なので、遅延を見込んで 3 日分を取り、最新の点を使う
    StartTime: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
    EndTime: now.toISOString(),
    Period: "86400",
    "Statistics.member.1": "Average",
  });
  return `https://monitoring.${region}.amazonaws.com/?${qs}`;
}

/** GetMetricStatisticsResponse の Datapoints から最新の Average を取り出す(データ点は時系列順とは限らない) */
export function latestAverage(xml: string): { value: number; timestamp: string } | null {
  const datapoints = xml.match(/<Datapoints>([\s\S]*?)<\/Datapoints>/)?.[1] ?? "";
  let best: { value: number; timestamp: string } | null = null;
  for (const m of datapoints.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
    const ts = m[1]!.match(/<Timestamp>([^<]+)<\/Timestamp>/)?.[1];
    const avg = Number(m[1]!.match(/<Average>([^<]+)<\/Average>/)?.[1]);
    if (!ts || !Number.isFinite(avg)) continue;
    if (!best || ts > best.timestamp) best = { value: avg, timestamp: ts };
  }
  return best;
}

export const awsS3: Collector = {
  meta: collectorMeta("aws-s3")!,
  async collect({ fields, now, fetch }) {
    const region = requireField(fields, "region", "リージョン");
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) throw new CollectorError("config", `リージョンの形式が正しくありません(例: ap-northeast-1): ${region}`);
    const bucket = requireField(fields, "bucket", "バケット名");
    const aws = new AwsClient({
      accessKeyId: requireField(fields, "accessKeyId", "アクセスキー ID"),
      secretAccessKey: requireField(fields, "secretAccessKey", "シークレットアクセスキー"),
      service: "monitoring",
      region,
    });

    const read = async (metric: "BucketSizeBytes" | "NumberOfObjects") => {
      const signed = await aws.sign(buildQuery(region, bucket, metric, now), { method: "GET" });
      const xml = await fetchText(fetch, signed.url, { method: "GET", headers: signed.headers }, `CloudWatch ${metric}`);
      return latestAverage(xml);
    };
    const size = await read("BucketSizeBytes");
    if (!size) {
      throw new CollectorError(
        "bad_response",
        `CloudWatch: バケット「${bucket}」のデータがありません。バケット名・リージョン(バケットのあるリージョン)を確認してください。作成直後のバケットは最初の報告まで 1 日ほどかかります`,
      );
    }
    const objects = await read("NumberOfObjects");
    return [
      { metricKey: "s3-storage-bytes", value: size.value },
      ...(objects ? [{ metricKey: "s3-objects", value: objects.value }] : []),
    ];
  },
};
