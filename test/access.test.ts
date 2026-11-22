import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireAccess } from "../src/worker/lib/access";

const app = new Hono<{ Bindings: Record<string, string> }>()
  .use("*", requireAccess as never)
  .get("/x", (c) => c.text("ok"));

const env = (over: Record<string, string>) => ({ REQUIRE_ACCESS: "true", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ...over });

describe("requireAccess", () => {
  it("Access 未設定の本番は 503(fail closed)", async () => {
    const res = await app.request("/x", {}, env({}));
    expect(res.status).toBe(503);
  });

  it("REQUIRE_ACCESS=false(ローカル開発)は通す", async () => {
    const res = await app.request("/x", {}, env({ REQUIRE_ACCESS: "false" }));
    expect(res.status).toBe(200);
  });

  it("設定済みでトークンなし・不正トークンは 401", async () => {
    const e = env({ ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "aud" });
    expect((await app.request("/x", {}, e)).status).toBe(401);
    const bad = await app.request("/x", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }, e);
    expect(bad.status).toBe(401);
  });
});
