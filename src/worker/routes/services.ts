import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";
import { metrics, services } from "../db/schema";
import { getDb, nowIso } from "../lib/db";
import { parseBody, parseId } from "../lib/http";
import { metricInput, serviceInput } from "../validation";

export const servicesRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const rows = await getDb(c.env.DB).select().from(services).orderBy(asc(services.name));
    return c.json(rows);
  })
  .post("/", async (c) => {
    const input = await parseBody(c, serviceInput);
    const [row] = await getDb(c.env.DB).insert(services).values(input).returning();
    return c.json(row, 201);
  })
  .get("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const db = getDb(c.env.DB);
    const service = await db.query.services.findFirst({ where: eq(services.id, id) });
    if (!service) return c.json({ error: "not found" }, 404);
    const ms = await db
      .select()
      .from(metrics)
      .where(eq(metrics.serviceId, id))
      .orderBy(asc(metrics.sortOrder), asc(metrics.id));
    return c.json({ service, metrics: ms });
  })
  .put("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await parseBody(c, serviceInput);
    const [row] = await getDb(c.env.DB)
      .update(services)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(services.id, id))
      .returning();
    return row ? c.json(row) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    // metrics / snapshots は ON DELETE CASCADE で削除される
    const rows = await getDb(c.env.DB).delete(services).where(eq(services.id, id)).returning({ id: services.id });
    return rows.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  })
  .post("/:id/metrics", async (c) => {
    const serviceId = parseId(c.req.param("id"));
    const input = await parseBody(c, metricInput);
    const db = getDb(c.env.DB);
    const exists = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
    if (!exists) return c.json({ error: "service not found" }, 404);
    const [row] = await db
      .insert(metrics)
      .values({ ...input, serviceId })
      .returning();
    return c.json(row, 201);
  });
