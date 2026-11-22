import { describe, expect, it, vi } from "vitest";
import { cloudflareWorkers, sumRequests } from "../src/worker/collectors/cloudflare-workers";
import { githubActions, sumSummary, sumUsage } from "../src/worker/collectors/github-actions";
import { googleDrive, parseQuota } from "../src/worker/collectors/google-drive";
import { fetchJson } from "../src/worker/collectors/http";
import { openaiCosts, sumCosts } from "../src/worker/collectors/openai-costs";
import { CollectorError } from "../src/worker/collectors/types";
import { decryptJson, encryptJson, secretHint } from "../src/worker/lib/crypto";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const now = new Date("2026-11-22T12:00:00Z");

/** URL ごとに応答を返す偽 fetch。呼ばれた URL を記録する */
function fakeFetch(routes: [RegExp, () => Response][]) {
  const calls: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes.find(([re]) => re.test(url));
    return r ? r[1]() : new Response("no route", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("fetchJson", () => {
  it("5xx は再試行して成功", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 2 ? new Response("down", { status: 503 }) : json({ ok: 1 }))) as unknown as typeof fetch;
    await expect(fetchJson(f, "https://x", {}, "X")).resolves.toEqual({ ok: 1 });
    expect(n).toBe(2);
  });
  it("401 は再試行せず auth エラー", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchJson(f, "https://x", {}, "X")).rejects.toMatchObject({ kind: "auth" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("Retry-After が長い 429 は待たずに rate_limit で失敗", async () => {
    const f = vi.fn(async () => new Response("slow", { status: 429, headers: { "Retry-After": "3600" } })) as unknown as typeof fetch;
    await expect(fetchJson(f, "https://x", {}, "X")).rejects.toMatchObject({ kind: "rate_limit" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub Actions", () => {
  it("Actions の分数と超過料金だけを合算(大文字小文字を区別しない)", () => {
    expect(
      sumSummary([
        { product: "Actions", sku: "linux", unitType: "Minutes", grossQuantity: 1200, netAmount: 0 },
        { product: "actions", sku: "storage", unitType: "GigabyteHours", grossQuantity: 50, netAmount: 0.5 },
        { product: "Copilot", sku: "x", unitType: "UserMonths", grossQuantity: 1, netAmount: 10 },
      ]),
    ).toEqual({ minutes: 1200, netUsd: 0.5 });
    expect(sumUsage([{ product: "actions", sku: "l", unitType: "minutes", quantity: 30, netAmount: 0 }]).minutes).toBe(30);
  });

  it("summary が 404 なら /usage にフォールバック", async () => {
    const { f, calls } = fakeFetch([
      [/usage\/summary/, () => new Response("nf", { status: 404 })],
      [/settings\/billing\/usage\?/, () => json({ usageItems: [{ product: "Actions", sku: "l", unitType: "Minutes", quantity: 42, netAmount: 0 }] })],
    ]);
    const r = await githubActions.collect({ fields: { username: "octo", token: "t" }, now, fetch: f });
    expect(r).toEqual([
      { metricKey: "actions-minutes", value: 42 },
      { metricKey: "actions-net-usd", value: 0 },
    ]);
    expect(calls[0]).toContain("year=2026&month=11&product=actions");
  });

  it("設定不足は config エラー", async () => {
    await expect(githubActions.collect({ fields: { token: "t" }, now, fetch })).rejects.toMatchObject({ kind: "config" });
  });
});

describe("Cloudflare Workers", () => {
  it("当日 UTC 0 時からのリクエスト数を合計", async () => {
    let body = "";
    const f = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return json({
        data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 100 } }, { sum: { requests: 23 } }] }] } },
        errors: null,
      });
    }) as unknown as typeof fetch;
    const r = await cloudflareWorkers.collect({ fields: { accountId: "acc", token: "t" }, now, fetch: f });
    expect(r).toEqual([{ metricKey: "workers-requests", value: 123 }]);
    expect(JSON.parse(body).variables).toMatchObject({ accountTag: "acc", datetimeStart: "2026-11-22T00:00:00.000Z" });
  });
  it("GraphQL エラーは bad_response、アカウント無しは auth", () => {
    expect(() => sumRequests({ data: null, errors: [{ message: "boom" }] })).toThrow(CollectorError);
    expect(() => sumRequests({ data: { viewer: { accounts: [] } }, errors: null })).toThrow(/アカウント/);
  });
});

describe("OpenAI costs", () => {
  it("ページをたどって合計", async () => {
    let page = 0;
    const f = vi.fn(async () =>
      json(
        ++page === 1
          ? { data: [{ results: [{ amount: { value: 1.234, currency: "usd" } }] }], has_more: true, next_page: "p2" }
          : { data: [{ results: [{ amount: { value: 2, currency: "usd" } }] }], has_more: false, next_page: null },
      ),
    ) as unknown as typeof fetch;
    const r = await openaiCosts.collect({ fields: { adminKey: "k" }, now, fetch: f });
    expect(r).toEqual([{ metricKey: "openai-cost-usd", value: 3.23 }]);
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![0])).toContain("page=p2");
  });
  it("USD 以外はエラー", () => {
    expect(() => sumCosts([{ data: [{ results: [{ amount: { value: 1, currency: "eur" } }] }], has_more: false, next_page: null }])).toThrow(
      /USD/,
    );
  });
});

describe("Google Drive", () => {
  it("トークン更新 → about.get、上限も返す", async () => {
    const { f } = fakeFetch([
      [/oauth2/, () => json({ access_token: "at" })],
      [/drive\/v3\/about/, () => json({ storageQuota: { limit: "16106127360", usage: "1073741824" } })],
    ]);
    const r = await googleDrive.collect({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, now, fetch: f });
    expect(r).toEqual([{ metricKey: "drive-storage", value: 1073741824, limitValue: 16106127360 }]);
  });
  it("limit が無い = 無制限(null)", () => {
    expect(parseQuota({ storageQuota: { usage: "5" } })).toEqual({ usage: 5, limit: null });
  });
  it("リフレッシュトークン失効は auth エラー", async () => {
    const { f } = fakeFetch([[/oauth2/, () => json({ error: "invalid_grant" }, 400)]]);
    await expect(
      googleDrive.collect({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, now, fetch: f }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("crypto", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  it("暗号化して復号できる・IV は毎回変わる", async () => {
    const a = await encryptJson(key, { token: "secret-1234" });
    const b = await encryptJson(key, { token: "secret-1234" });
    expect(a.ciphertext).not.toContain("secret");
    expect(a.iv).not.toBe(b.iv);
    expect(await decryptJson(key, a)).toEqual({ token: "secret-1234" });
  });
  it("鍵が違えば復号できない", async () => {
    const a = await encryptJson(key, { token: "x" });
    await expect(decryptJson(Buffer.alloc(32, 8).toString("base64"), a)).rejects.toThrow();
  });
  it("鍵未設定はエラー", async () => {
    await expect(encryptJson(undefined, { a: "b" })).rejects.toThrow(/MASTER_KEY/);
  });
  it("ヒントは末尾 4 文字だけ", () => expect(secretHint({ token: "abcdefgh" })).toBe("token: …efgh"));
});
