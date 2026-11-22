import { Hono } from "hono";
import type { Env } from "../env";
import { getDb } from "../lib/db";
import { getSettings } from "../lib/settings";
import { loadDashboard } from "../lib/statuses";

export const dashboardRoute = new Hono<{ Bindings: Env }>().get("/", async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await loadDashboard(db, await getSettings(db), new Date()));
});
