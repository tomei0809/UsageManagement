import { z } from "zod";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const serviceInput = z.object({
  name: z.string().trim().min(1).max(100),
  category: optText(50),
  url: optText(500).refine((v) => v === null || /^https?:\/\//.test(v), "URL は http(s):// で始めてください"),
  notes: optText(2000),
  freeTierEndsAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "無料期間の終了日は YYYY-MM-DD で指定してください")
    .nullish()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  pauseOnFreeTierEnd: z.boolean().default(false),
});

export const metricInput = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9][a-z0-9_.-]*$/, "key は半角英小文字・数字・_ . - のみ"),
    label: z.string().trim().min(1).max(100),
    unit: z.string().trim().min(1).max(30),
    kind: z.enum(["cumulative", "gauge"]),
    limitValue: z.number().positive().nullable(),
    resetType: z.enum(["monthly", "daily", "weekly", "rolling", "none"]),
    resetAnchor: z.number().int().nullable(),
    resetTimezone: z
      .string()
      .trim()
      .min(1)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "不正なタイムゾーンです"),
    cautionPct: z.number().min(0).max(1000),
    warningPct: z.number().min(0).max(1000),
    staleAfterHours: z.number().int().min(1).max(24 * 365),
    sortOrder: z.number().int().default(0),
  })
  .superRefine((m, ctx) => {
    if (m.cautionPct > m.warningPct) {
      ctx.addIssue({ code: "custom", path: ["cautionPct"], message: "注意の閾値は警告以下にしてください" });
    }
    const a = m.resetAnchor;
    const bad =
      (m.resetType === "monthly" && (a === null || a < 1 || a > 31)) ||
      (m.resetType === "weekly" && (a === null || a < 0 || a > 6)) ||
      (m.resetType === "rolling" && (a === null || a < 1));
    if (bad) {
      ctx.addIssue({
        code: "custom",
        path: ["resetAnchor"],
        message: "monthly は 1-31 日、weekly は 0-6(0=日曜)、rolling は 1 以上の時間数を指定してください",
      });
    }
  });

export const snapshotInput = z.object({
  value: z.number().min(0),
  collectedAt: z.iso.datetime({ offset: true }).optional(),
  note: optText(500),
});
