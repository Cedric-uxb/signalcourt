import { z } from "zod";

const MAX_RESPONSE_BYTES = 512 * 1024;

class ResponseTooLargeError extends Error {
  constructor() {
    super("Tavily response is too large");
  }
}

const tavilyResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().trim().min(1),
      url: z.string().trim().pipe(z.url({ protocol: /^https?$/ })),
      content: z.string().trim().min(1),
    }),
  ),
});

export type NewsSearchResult = {
  title: string;
  url: string;
  excerpt: string;
};

type CancelableBody = {
  cancel(reason?: unknown): Promise<void>;
};

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
    await safeCancelBody(response.body, "Tavily response is too large");
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
        await safeCancelBody(reader, "Tavily response is too large");
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function searchNews(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NewsSearchResult[]> {
  const normalizedQuery = query.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedQuery) throw new Error("Tavily query must not be empty");
  if (!normalizedApiKey) throw new Error("Tavily API key must not be empty");

  let response: Response;
  try {
    response = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: normalizedApiKey,
        query: normalizedQuery,
        topic: "news",
        max_results: 5,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Tavily request failed");
  }

  if (!response.ok) {
    await safeCancelBody(response.body);
    throw new Error(`Tavily search failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await safeCancelBody(response.body);
    throw new Error("Tavily response must be JSON");
  }

  let responseText: string;
  try {
    responseText = await readLimitedText(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw error;
    }
    throw new Error("Tavily response read failed");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("Tavily returned invalid JSON");
  }

  const parsed = tavilyResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Tavily response schema is invalid", { cause: parsed.error });
  }

  return parsed.data.results.slice(0, 5).map(({ title, url, content }) => ({
    title,
    url,
    excerpt: content.trim(),
  }));
}
