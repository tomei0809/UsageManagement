import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "JSON を送信してください" });
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    const message = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HTTPException(400, { message });
  }
  return r.data;
}

export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "不正な ID です" });
  return id;
}
