import { z } from "zod";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 5_000;
const TOOL_PATTERN = /^[A-Za-z0-9_-]+$/;

const jsonObjectSchema = z.record(z.string(), z.json());
const resultSchema = z.object({
  schema_version: z.string().trim().min(1),
  tool: z.string(),
  status: z.enum(["ok", "partial", "unavailable"]),
  data_mode: z.enum(["live", "mixed", "simulated", "unknown"]),
  as_of: z.iso.datetime({ offset: true }),
  request: jsonObjectSchema,
  data: z.json(),
  summary: z.object({ headline: z.string().trim().min(1) }).strict(),
  availability: jsonObjectSchema,
  warnings: z.array(z.string()),
}).strict();
const callResponseSchema = z.object({ result: resultSchema }).strict();

class ResponseTooLargeError extends Error {
  constructor() {
    super("RYO response is too large");
  }
}

type Sleep = (milliseconds: number) => Promise<void>;
type Now = () => number;

type Options = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: Sleep;
  nowImpl?: Now;
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
    throw new Error("RYO base URL must be a valid HTTPS URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.href.includes("?") ||
    parsed.href.includes("#")
  ) {
    throw new Error("RYO base URL must be a valid HTTPS URL without credentials, query, or hash");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${parsed.pathname}`;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function safeCancelBody(body: CancelableBody | null, reason?: unknown): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    // Cancellation is best-effort and must not replace the primary error.
  }
}

function retryDelayMilliseconds(
  retryAfter: string | null,
  retryIndex: number,
  nowImpl: Now,
): number {
  const normalized = retryAfter?.trim();
  if (normalized !== undefined) {
    if (/^[0-9]+$/.test(normalized)) {
      const delaySeconds = normalized.replace(/^0+/, "") || "0";
      const capSeconds = String(RETRY_AFTER_CAP_MS / 1_000);
      if (
        delaySeconds.length > capSeconds.length ||
        (delaySeconds.length === capSeconds.length && delaySeconds > capSeconds)
      ) {
        return RETRY_AFTER_CAP_MS;
      }
      return Number(delaySeconds) * 1_000;
    }

    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
      const retryAt = Date.parse(normalized);
      if (!Number.isNaN(retryAt)) {
        return Math.min(Math.max(0, retryAt - nowImpl()), RETRY_AFTER_CAP_MS);
      }
    }
  }
  return 100 * 2 ** retryIndex;
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await safeCancelBody(response.body, "RYO response is too large");
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
        await safeCancelBody(reader, "RYO response is too large");
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    await safeCancelBody(response.body);
    throw new Error("RYO response must be JSON");
  }

  let responseText: string;
  try {
    responseText = await readLimitedText(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw error;
    throw new Error("RYO response read failed");
  }

  if (!responseText.trim()) throw new Error("RYO response body is empty");

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new Error("RYO returned invalid JSON");
  }
}

export function createRyoClient({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  nowImpl = Date.now,
}: Options) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) throw new Error("RYO API key must not be empty");

  async function request(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error("RYO request failed");
      }

      const retryable = response.status === 429 || response.status === 503;
      if (!retryable || attempt === MAX_ATTEMPTS - 1) return response;

      await safeCancelBody(response.body);
      await sleepImpl(
        retryDelayMilliseconds(response.headers.get("retry-after"), attempt, nowImpl),
      );
    }

    throw new Error("RYO request failed");
  }

  async function requireSuccess(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    await safeCancelBody(response.body);
    throw new Error(`${operation} failed with status ${response.status}`);
  }

  return {
    async catalog() {
      const response = await request("/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${normalizedApiKey}` },
      });
      await requireSuccess(response, "RYO catalog");

      const payload = await parseJsonResponse(response);
      const parsed = jsonObjectSchema.safeParse(payload);
      if (!parsed.success) throw new Error("RYO catalog schema is invalid");
      return parsed.data;
    },

    async call(tool: string, arguments_: Record<string, unknown>) {
      const normalizedTool = tool.trim();
      if (!TOOL_PATTERN.test(normalizedTool)) {
        throw new Error("RYO tool must be a safe non-empty path segment");
      }

      let serializedArguments: string;
      try {
        const parsed = jsonObjectSchema.safeParse(arguments_);
        if (!parsed.success) throw new Error();
        serializedArguments = JSON.stringify(parsed.data);
      } catch {
        throw new Error("RYO arguments must be a JSON object");
      }

      const response = await request(`/tools/${encodeURIComponent(normalizedTool)}/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedApiKey}`,
          "Content-Type": "application/json",
        },
        body: serializedArguments,
      });
      await requireSuccess(response, `RYO ${normalizedTool}`);

      const payload = await parseJsonResponse(response);
      const parsed = callResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("RYO response schema is invalid");
      if (parsed.data.result.tool !== normalizedTool) {
        throw new Error("RYO response tool mismatch");
      }

      const result = parsed.data.result;
      return {
        tool: result.tool,
        status: result.status,
        dataMode: result.data_mode,
        asOf: result.as_of,
        request: result.request,
        data: result.data,
        summary: result.summary.headline,
        availability: result.availability,
        warnings: result.warnings,
      };
    },
  };
}
