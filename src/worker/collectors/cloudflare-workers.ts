import { collectorMeta } from "../../shared/collectors";
import { fetchJson, requireField } from "./http";
import { CollectorError, type Collector } from "./types";

const QUERY = `query GetWorkersRequests($accountTag: string, $datetimeStart: string, $datetimeEnd: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}) {
        sum { requests }
        dimensions { scriptName }
      }
    }
  }
}`;

export interface GqlResponse {
  data: { viewer: { accounts: { workersInvocationsAdaptive: { sum: { requests: number } }[] }[] } } | null;
  errors: { message: string }[] | null;
}

export function sumRequests(body: GqlResponse): number {
  if (body.errors?.length) throw new CollectorError("bad_response", `Cloudflare GraphQL: ${body.errors[0]!.message}`);
  const accounts = body.data?.viewer.accounts ?? [];
  if (accounts.length === 0) {
    throw new CollectorError(
      "auth",
      "Cloudflare: アカウントが見つかりません。Account ID とトークンの対象アカウントを確認してください",
    );
  }
  return accounts[0]!.workersInvocationsAdaptive.reduce((s, r) => s + (r.sum?.requests ?? 0), 0);
}

/** 当日(UTC 0 時〜現在)の Workers リクエスト数(全スクリプト合計) */
export const cloudflareWorkers: Collector = {
  meta: collectorMeta("cloudflare-workers")!,
  async collect({ fields, now, fetch }) {
    const accountTag = requireField(fields, "accountId", "Account ID");
    const token = requireField(fields, "token", "API トークン");
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const body = await fetchJson<GqlResponse>(
      fetch,
      "https://api.cloudflare.com/client/v4/graphql",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: QUERY,
          variables: { accountTag, datetimeStart: start.toISOString(), datetimeEnd: now.toISOString() },
        }),
      },
      "Cloudflare GraphQL",
    );
    return [{ metricKey: "workers-requests", value: sumRequests(body) }];
  },
};
