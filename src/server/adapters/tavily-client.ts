import { z } from "zod";

const tavilyResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().trim().min(1),
      url: z.string().trim().pipe(z.url({ protocol: /^https?$/ })),
      content: z.string(),
    }),
  ),
});

export type NewsSearchResult = {
  title: string;
  url: string;
  excerpt: string;
};

export async function searchNews(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NewsSearchResult[]> {
  const normalizedQuery = query.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedQuery) throw new Error("Tavily query must not be empty");
  if (!normalizedApiKey) throw new Error("Tavily API key must not be empty");

  const response = await fetchImpl("https://api.tavily.com/search", {
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

  if (!response.ok) {
    throw new Error(`Tavily search failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error("Tavily response must be JSON");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch (error) {
    throw new Error("Tavily returned invalid JSON", { cause: error });
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
