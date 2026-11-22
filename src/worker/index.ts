import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env";
import { requireAccess } from "./lib/access";
import { dashboardRoute } from "./routes/dashboard";
import { metricsRoute, snapshotsRoute } from "./routes/metrics";
import { servicesRoute } from "./routes/services";
import { collectorsRoute, metricPollingRoute, serviceCollectorRoute, settingsRoute } from "./routes/collectors";
import { runScheduled } from "./collect";
import { getDb } from "./lib/db";
import { evaluateAlerts } from "./notify";

const api = new Hono<{ Bindings: Env }>()
  .use("*", requireAccess)
  .route("/dashboard", dashboardRoute)
  .route("/services", servicesRoute)
  .route("/services", serviceCollectorRoute)
  .route("/metrics", metricsRoute)
  .route("/metrics", metricPollingRoute)
  .route("/collectors", collectorsRoute)
  .route("/settings", settingsRoute)
  .route("/snapshots", snapshotsRoute);

const app = new Hono<{ Bindings: Env }>()
  .route("/api", api)
  .notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.env.ASSETS.fetch(c.req.raw)))
  .onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

export default {
  fetch: app.fetch,
  /** Cron Triggers(wrangler.jsonc の triggers.crons)。停止判定はすべて runScheduled 内で行う */
  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil(
      (async () => {
        const r = await runScheduled(env, now);
        console.log("scheduled run", JSON.stringify(r));
        // 取得の有無に関係なく通知を評価(手動入力の指標・無料期間の終了日も対象)
        const a = await evaluateAlerts(env, getDb(env.DB), now);
        console.log("alerts", JSON.stringify(a));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
