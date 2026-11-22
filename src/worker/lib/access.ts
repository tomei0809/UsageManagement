/**
 * Cloudflare Access の JWT(Cf-Access-Jwt-Assertion)を検証する。
 * Access がエッジでアプリ全体を保護しているが、Worker 側でも検証して
 * workers.dev 直アクセス等の迂回を防ぐ(多層防御)。
 */
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

interface Jwk extends JsonWebKey {
  kid: string;
}

let jwksCache: { domain: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getKeys(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.domain === teamDomain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { domain: teamDomain, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

export async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson<{ alg: string; kid: string }>(h);
  if (header.alg !== "RS256") return false;
  const jwk = (await getKeys(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return false;

  const payload = decodeJson<{ aud: string | string[]; exp: number; iss: string }>(p);
  const nowSec = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return auds.includes(aud) && payload.exp > nowSec && payload.iss === `https://${teamDomain}`;
}

export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.REQUIRE_ACCESS === "false") return next();

  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) {
    // 設定漏れのまま公開しないよう fail closed
    return c.json({ error: "Cloudflare Access が未設定です(ACCESS_TEAM_DOMAIN / ACCESS_AUD)" }, 503);
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token || !(await verifyAccessJwt(token, team, aud).catch(() => false))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};
