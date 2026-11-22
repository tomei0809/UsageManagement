import { describe, expect, it, vi } from "vitest";
import { awsS3, buildQuery, latestAverage } from "../src/worker/collectors/aws-s3";

const xml = (points: [string, number][]) => `<GetMetricStatisticsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/">
  <GetMetricStatisticsResult>
    <Datapoints>
      ${points.map(([t, v]) => `<member><Timestamp>${t}</Timestamp><Unit>Bytes</Unit><Average>${v}</Average></member>`).join("\n")}
    </Datapoints>
    <Label>BucketSizeBytes</Label>
  </GetMetricStatisticsResult>
</GetMetricStatisticsResponse>`;

const now = new Date("2026-11-22T12:00:00Z");
const fields = { region: "ap-northeast-1", bucket: "my-bucket", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };

describe("AWS S3", () => {
  it("GetMetricStatistics のクエリ(GetMetricData は使わない)", () => {
    const u = new URL(buildQuery("ap-northeast-1", "my-bucket", "BucketSizeBytes", now));
    expect(u.host).toBe("monitoring.ap-northeast-1.amazonaws.com");
    expect(u.searchParams.get("Action")).toBe("GetMetricStatistics");
    expect(u.searchParams.get("Namespace")).toBe("AWS/S3");
    expect(u.searchParams.get("Dimensions.member.2.Value")).toBe("StandardStorage");
    expect(u.searchParams.get("Period")).toBe("86400");
    expect(new URL(buildQuery("ap-northeast-1", "b", "NumberOfObjects", now)).searchParams.get("Dimensions.member.2.Value")).toBe(
      "AllStorageTypes",
    );
  });

  it("データ点は順不同なので最新の時刻を選ぶ", () => {
    expect(latestAverage(xml([["2026-11-21T00:00:00Z", 200], ["2026-11-20T00:00:00Z", 100]]))).toEqual({
      value: 200,
      timestamp: "2026-11-21T00:00:00Z",
    });
    expect(latestAverage(xml([]))).toBeNull();
  });

  it("SigV4 で署名して 2 指標を取得", async () => {
    const auth: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("Authorization") ?? "");
      const metric = new URL(String(input)).searchParams.get("MetricName");
      return new Response(xml([["2026-11-21T00:00:00Z", metric === "BucketSizeBytes" ? 1073741824 : 42]]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await awsS3.collect({ fields, now, fetch: f });
    expect(r).toEqual([
      { metricKey: "s3-storage-bytes", value: 1073741824 },
      { metricKey: "s3-objects", value: 42 },
    ]);
    expect(auth[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/ap-northeast-1\/monitoring\/aws4_request/);
  });

  it("データなし・不正なリージョンは分かるエラー", async () => {
    const empty = vi.fn(async () => new Response(xml([]), { status: 200 })) as unknown as typeof fetch;
    await expect(awsS3.collect({ fields, now, fetch: empty })).rejects.toThrow(/データがありません/);
    await expect(awsS3.collect({ fields: { ...fields, region: "tokyo" }, now, fetch: empty })).rejects.toMatchObject({ kind: "config" });
  });

  it("403 は認証エラー", async () => {
    const denied = vi.fn(async () => new Response("<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>", { status: 403 })) as unknown as typeof fetch;
    await expect(awsS3.collect({ fields, now, fetch: denied })).rejects.toMatchObject({ kind: "auth" });
  });
});
