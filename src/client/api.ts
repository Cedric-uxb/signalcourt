import { z } from "zod";

import {
  receiptSchema,
  type AnalysisRequest,
  type Receipt,
} from "../shared/contracts";

const systemStatusSchema = z.object({
  mode: z.enum(["demo", "live"]),
  capabilities: z.object({
    ryo: z.boolean(),
    news: z.boolean(),
    model: z.boolean(),
  }),
  demoAvailable: z.boolean(),
  publisherRegistryConfigured: z.boolean(),
});

const replayResultSchema = z.object({
  id: z.string().min(1),
  identical: z.boolean(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type ReplayResult = z.infer<typeof replayResultSchema>;

const errorMessages: Record<string, string> = {
  ANALYSIS_UNAVAILABLE: "Analysis service is temporarily unavailable. Try again.",
  INVALID_ANALYSIS_REQUEST: "Review the URL, token, and risk level, then try again.",
  INVALID_RECEIPT_ID: "This receipt identifier cannot be replayed.",
  RECEIPT_NOT_FOUND: "The stored receipt could not be found.",
  RECEIPT_UNAVAILABLE: "Receipt replay is temporarily unavailable. Try again.",
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = z.object({ error: z.string() }).parse(await response.json());
    return new Error(errorMessages[body.error] ?? fallback);
  } catch {
    return new Error(fallback);
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  fallback: string,
): Promise<T> {
  if (!response.ok) throw await responseError(response, fallback);
  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error("The service returned an unreadable response.");
  }
}

export async function createAnalysis(input: AnalysisRequest): Promise<Receipt> {
  const response = await fetch("/api/analyses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseResponse(response, receiptSchema, "Analysis could not be completed.");
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const response = await fetch("/api/system", { headers: { Accept: "application/json" } });
  return parseResponse(response, systemStatusSchema, "System status is unavailable.");
}

export async function replayReceipt(receiptId: string): Promise<ReplayResult> {
  const response = await fetch(`/api/receipts/${encodeURIComponent(receiptId)}/replay`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  return parseResponse(response, replayResultSchema, "Receipt replay could not be completed.");
}
