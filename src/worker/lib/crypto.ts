/**
 * 秘密情報の暗号化(AES-256-GCM)。鍵は Workers Secret の MASTER_KEY(base64 の 32 バイト)。
 * 生成例: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import { HTTPException } from "hono/http-exception";

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(masterKey: string | undefined): Promise<CryptoKey> {
  if (!masterKey) {
    throw new HTTPException(500, {
      message: "MASTER_KEY が設定されていません(wrangler secret put MASTER_KEY / ローカルは .dev.vars)",
    });
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = unb64(masterKey.trim());
  } catch {
    throw new HTTPException(500, { message: "MASTER_KEY は base64 で指定してください" });
  }
  if (raw.length !== 32) throw new HTTPException(500, { message: "MASTER_KEY は 32 バイト(base64)にしてください" });
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(masterKey: string | undefined, data: Record<string, string>) {
  const key = await importKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { ciphertext: b64(ct), iv: b64(iv) };
}

export async function decryptJson(
  masterKey: string | undefined,
  enc: { ciphertext: string; iv: string },
): Promise<Record<string, string>> {
  const key = await importKey(masterKey);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(enc.iv) }, key, unb64(enc.ciphertext));
  return JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
}

/** 画面表示用ヒント(末尾 4 文字のみ) */
export function secretHint(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: …${v.slice(-4)}`)
    .join(", ");
}
