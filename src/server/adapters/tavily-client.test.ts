import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { searchNews } from "./tavily-client.js";

const fixtureUrl = new URL("../../../tests/fixtures/tavily.json", import.meta.url);

describe("searchNews", () => {
  it("posts the trimmed request and normalizes at most five fixture results", async () => {
    const fixture = await readFile(fixtureUrl, "utf8");
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(fixture, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    );

    const results = await searchNews("  token listing  ", "  secret-key  ", fetchImpl);

    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({
      title: "Exchange confirms listing",
      url: "https://news.example.com/listing",
      excerpt: "The exchange confirmed the listing.",
    });
    expect(results.some(({ title }) => title === "Sixth result is truncated")).toBe(false);

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl).toBe("https://api.tavily.com/search");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      api_key: "secret-key",
      query: "token listing",
      topic: "news",
      max_results: 5,
    });
    expect(String(requestUrl)).not.toContain("secret-key");
  });

  it.each([
    { query: "", apiKey: "key", message: /query/i },
    { query: "   ", apiKey: "key", message: /query/i },
    { query: "bitcoin", apiKey: "", message: /API key/i },
    { query: "bitcoin", apiKey: "   ", message: /API key/i },
  ])("fails fast for empty input %#", async ({ query, apiKey, message }) => {
    const fetchImpl = vi.fn();

    await expect(searchNews(query, apiKey, fetchImpl)).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose the API key in validation errors", async () => {
    const sentinel = "test-key-sentinel";

    await expect(searchNews("", sentinel, vi.fn())).rejects.not.toThrow(sentinel);
  });

  it("sanitizes transport errors that contain the API key and request body", async () => {
    const sentinel = "transport-key-sentinel";
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const serializedBody = String(init?.body);
        throw new Error(`transport leaked ${sentinel} ${serializedBody}`, {
          cause: { sentinel, serializedBody },
        });
      },
    );

    let rejection: unknown;
    try {
      await searchNews("bitcoin", sentinel, fetchImpl);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const exposedError = rejection as Error;
    expect(exposedError.message).toBe("Tavily request failed");
    expect(exposedError.cause).toBeUndefined();
    expect(JSON.stringify(exposedError)).not.toContain(sentinel);
    expect(JSON.stringify({
      message: exposedError.message,
      cause: exposedError.cause,
    })).not.toContain(sentinel);
  });

  it("reports non-success status codes", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(/503/);
  });

  it("rejects a non-JSON content type", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(/JSON/i);
  });

  it("rejects malformed JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(/invalid JSON/i);
  });

  it.each([
    { results: [{ title: "", url: "https://example.com", content: "empty title" }] },
    { results: [{ title: "Title", url: "   ", content: "empty URL" }] },
    { results: [{ title: "Title", url: "file:///tmp/result", content: "bad URL" }] },
    { results: [{ title: "Title", url: "https://example.com", content: 42 }] },
    { results: "not-an-array" },
  ])("rejects malformed response schema %#", async (payload) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(/schema/i);
  });
});
