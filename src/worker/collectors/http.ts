import { CollectorError } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 429 / 5xx / 通信エラーは指数バックオフで再試行(既定 2 回: 0.5s, 1.5s)。
 * Retry-After が 10 秒以内ならそれに従う。それ以上待つ必要があるときは失敗として次回の定期実行に回す。
 * 401/403/404 などはエラー種別を付けて即失敗。
 */
export function fetchJson<T>(f: typeof fetch, url: string, init: RequestInit, label: string, retries = 2): Promise<T> {
  return fetchWithRetry(f, url, init, label, retries, async (res) => {
    try {
      return (await res.json()) as T;
    } catch {
      throw new CollectorError("bad_response", `${label}: 応答が JSON ではありません`);
    }
  });
}

/** XML など JSON 以外の応答用 */
export function fetchText(f: typeof fetch, url: string, init: RequestInit, label: string, retries = 2): Promise<string> {
  return fetchWithRetry(f, url, init, label, retries, (res) => res.text());
}

async function fetchWithRetry<T>(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  retries: number,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  let lastError: CollectorError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 3 ** (attempt - 1));
    let res: Response;
    try {
      res = await f(url, init);
    } catch (e) {
      lastError = new CollectorError("network", `${label}: 通信に失敗しました(${e instanceof Error ? e.message : e})`);
      continue;
    }
    if (res.ok) return parse(res);
    const detail = await safeText(res);
    if (res.status === 429 || res.status >= 500) {
      lastError = new CollectorError(
        res.status === 429 ? "rate_limit" : "network",
        `${label}: HTTP ${res.status}${detail}`,
      );
      const retryAfter = Number(res.headers.get("Retry-After"));
      if (Number.isFinite(retryAfter) && retryAfter > 10) break;
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new CollectorError("auth", `${label}: 認証に失敗しました(HTTP ${res.status})。トークンと権限を確認してください${detail}`);
    }
    if (res.status === 404) {
      throw new CollectorError("not_supported", `${label}: 見つかりません(HTTP 404)。このアカウントでは利用できない可能性があります${detail}`);
    }
    throw new CollectorError("bad_response", `${label}: HTTP ${res.status}${detail}`);
  }
  throw lastError ?? new CollectorError("network", `${label}: 取得に失敗しました`);
}

/** エラー本文の先頭だけ(トークン等が含まれないよう短く切る) */
async function safeText(res: Response): Promise<string> {
  try {
    const t = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 160);
    return t ? ` — ${t}` : "";
  } catch {
    return "";
  }
}

export function requireField(fields: Record<string, string>, key: string, label: string): string {
  const v = fields[key]?.trim();
  if (!v) throw new CollectorError("config", `${label} が設定されていません`);
  return v;
}
