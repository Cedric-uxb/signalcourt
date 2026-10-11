import { z } from "zod";

import { bearArgumentSchema, bullArgumentSchema } from "../../shared/contracts.js";
import {
  claimPrompt,
  debatePrompt,
  promptVersion,
  systemBoundary,
} from "../analysis/prompts.js";

const MAX_RESPONSE_BYTES = 512 * 1024;

const claimSchema = z
  .object({
    id: z.string().trim().min(1),
    text: z.string().trim().min(1),
  })
  .strict();

const claimsOutputSchema = z
  .object({
    claims: z
      .array(claimSchema)
      .max(3)
      .refine((claims) => new Set(claims.map(({ id }) => id)).size === claims.length),
  })
  .strict();

const citationsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .refine((citations) => new Set(citations).size === citations.length);

const strictBullArgumentSchema = bullArgumentSchema
  .extend({
    thesis: z.string().trim().min(1),
    citations: citationsSchema,
  })
  .strict();

const strictBearArgumentSchema = bearArgumentSchema
  .extend({
    thesis: z.string().trim().min(1),
    citations: citationsSchema,
  })
  .strict();

const completionEnvelopeSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().trim().min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const jsonValueSchema = z.json();

class ResponseTooLargeError extends Error {
  constructor() {
    super("LLM response is too large");
  }
}

type Options = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
};

type CancelableBody = {
  cancel(reason?: unknown): Promise<void>;
};

function normalizeBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("LLM base URL must be a valid HTTPS URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.href.includes("?") ||
    parsed.href.includes("#")
  ) {
    throw new Error("LLM base URL must be a valid HTTPS URL without credentials, query, or hash");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${parsed.pathname}`;
}

async function safeCancelBody(body: CancelableBody | null, reason?: unknown): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    // Cancellation is best-effort and must not replace the primary error.
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await safeCancelBody(response.body, "LLM response is too large");
    throw new ResponseTooLargeError();
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await safeCancelBody(reader, "LLM response is too large");
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function parseCompletionResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await safeCancelBody(response.body);
    throw new Error("LLM response must be JSON");
  }

  let responseText: string;
  try {
    responseText = await readLimitedText(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw error;
    throw new Error("LLM response read failed");
  }

  if (!responseText.trim()) throw new Error("LLM response body is empty");

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error("LLM returned invalid JSON");
  }

  const envelope = completionEnvelopeSchema.safeParse(payload);
  if (!envelope.success) throw new Error("LLM response schema is invalid");

  try {
    return JSON.parse(envelope.data.choices[0]!.message.content) as unknown;
  } catch {
    throw new Error("LLM response content is invalid JSON");
  }
}

export function createLlmClient({ baseUrl, apiKey, model, fetchImpl = fetch }: Options) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedApiKey = apiKey.trim();
  const normalizedModel = model.trim();
  if (!normalizedApiKey) throw new Error("LLM API key must not be empty");
  if (!normalizedModel) throw new Error("LLM model must not be empty");

  async function complete(user: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: normalizedModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemBoundary },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("LLM request failed");
    }

    if (!response.ok) {
      await safeCancelBody(response.body);
      throw new Error(`LLM request failed with status ${response.status}`);
    }

    return parseCompletionResponse(response);
  }

  return {
    async extractClaims(articleText: string) {
      const output = await complete(claimPrompt(articleText));
      const parsed = claimsOutputSchema.safeParse(output);
      if (!parsed.success) throw new Error("LLM response content schema is invalid");
      return parsed.data.claims;
    },

    async argue(stance: "bull" | "bear", evidence: unknown) {
      if (stance !== "bull" && stance !== "bear") {
        throw new Error("Debate stance must be bull or bear");
      }

      let parsedEvidence: ReturnType<typeof jsonValueSchema.safeParse>;
      try {
        parsedEvidence = jsonValueSchema.safeParse(evidence);
      } catch {
        throw new Error("LLM evidence must be JSON-compatible");
      }
      if (!parsedEvidence.success) throw new Error("LLM evidence must be JSON-compatible");

      let userPrompt: string;
      try {
        userPrompt = debatePrompt(stance, parsedEvidence.data);
      } catch (error) {
        if (error instanceof Error && error.message === "Evidence data must be JSON-compatible") {
          throw new Error("LLM evidence must be JSON-compatible");
        }
        throw error;
      }

      const output = await complete(userPrompt);
      const schema = stance === "bull" ? strictBullArgumentSchema : strictBearArgumentSchema;
      const parsed = schema.safeParse(output);
      if (!parsed.success) throw new Error("LLM response content schema is invalid");
      return parsed.data;
    },

    model: normalizedModel,
    promptVersion,
  };
}
