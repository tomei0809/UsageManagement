import { collectorMeta } from "../../shared/collectors";
import { fetchJson, requireField } from "./http";
import { CollectorError, type Collector } from "./types";

export interface AboutResponse {
  storageQuota?: { limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string };
}

/** storageQuota の値は bytes の文字列。limit が無い = 無制限 */
export function parseQuota(body: AboutResponse) {
  const q = body.storageQuota;
  const usage = Number(q?.usage);
  if (!q || q.usage === undefined || !Number.isFinite(usage)) {
    throw new CollectorError("bad_response", "Google Drive: storageQuota.usage がありません");
  }
  const limit = q.limit === undefined ? null : Number(q.limit);
  return { usage, limit: limit !== null && Number.isFinite(limit) ? limit : null };
}

/** リフレッシュトークンでアクセストークンを取り直し、about.get(fields=storageQuota)を呼ぶ */
export const googleDrive: Collector = {
  meta: collectorMeta("google-drive")!,
  async collect({ fields, fetch }) {
    const clientId = requireField(fields, "clientId", "クライアント ID");
    const clientSecret = requireField(fields, "clientSecret", "クライアントシークレット");
    const refreshToken = requireField(fields, "refreshToken", "リフレッシュトークン");

    let accessToken: string | undefined;
    try {
      const token = await fetchJson<{ access_token?: string }>(
        fetch,
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }).toString(),
        },
        "Google OAuth",
        1,
      );
      accessToken = token.access_token;
    } catch (e) {
      // 失効(invalid_grant)は HTTP 400 で返る
      if (e instanceof CollectorError && e.kind === "bad_response") {
        throw new CollectorError(
          "auth",
          `Google OAuth: トークンを更新できません。リフレッシュトークンが失効している可能性があります(${e.message})`,
        );
      }
      throw e;
    }
    if (!accessToken) throw new CollectorError("auth", "Google OAuth: access_token が返りませんでした");

    const about = await fetchJson<AboutResponse>(
      fetch,
      "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "Google Drive about",
    );
    const { usage, limit } = parseQuota(about);
    return [{ metricKey: "drive-storage", value: usage, limitValue: limit }];
  },
};
