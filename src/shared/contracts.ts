import { z } from "zod";

import { reasonCodes } from "./reason-codes.js";

export const riskLevelSchema = z.enum([
  "conservative",
  "balanced",
  "aggressive",
]);
export const verdictSchema = z.enum(["LONG", "SHORT", "NO_TRADE"]);
export const claimStatusSchema = z.enum([
  "verified",
  "disputed",
  "unsupported",
  "unavailable",
]);

export const analysisRequestSchema = z.object({
  articleUrl: z.url({ protocol: /^https?$/ }),
  token: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/),
  riskLevel: riskLevelSchema,
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["article", "news", "ryo"]),
  source: z.string().min(1),
  retrievedAt: z.string().datetime(),
  observedAt: z.string().datetime().nullable(),
  status: z.enum(["ok", "partial", "unavailable"]),
  dataMode: z.enum(["live", "mixed", "simulated", "unknown"]),
  payload: z.json(),
  summary: z.string(),
  warnings: z.array(z.string()),
});

export const claimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: claimStatusSchema,
  evidenceIds: z.array(z.string()),
  explanation: z.string().min(1),
});

const argumentShape = {
  thesis: z.string().min(1),
  confidence: z.number().min(0).max(1),
  citations: z.array(z.string()).min(1),
};

export const bullArgumentSchema = z.object({
  stance: z.literal("bull"),
  ...argumentShape,
});

export const bearArgumentSchema = z.object({
  stance: z.literal("bear"),
  ...argumentShape,
});

export const argumentSchema = z.discriminatedUnion("stance", [
  bullArgumentSchema,
  bearArgumentSchema,
]);

export const riskPlanSchema = z.object({
  entry: z.number().positive(),
  stop: z.number().positive(),
  target: z.number().positive(),
  practiceSizeUsd: z.number().positive(),
});

export const receiptSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  input: analysisRequestSchema,
  evidence: z.array(evidenceSchema),
  claims: z.array(claimSchema),
  arguments: z.tuple([bullArgumentSchema, bearArgumentSchema]),
  verdict: verdictSchema,
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(z.enum(reasonCodes)),
  causalChain: z.array(z.string()),
  riskPlan: riskPlanSchema.nullable(),
  model: z.object({ name: z.string(), promptVersion: z.string() }),
  replay: z.object({ evidenceHash: z.string(), identical: z.boolean() }),
});

export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Argument = z.infer<typeof argumentSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
