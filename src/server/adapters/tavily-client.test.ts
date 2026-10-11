import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { searchNews } from "./tavily-client.js";

const fixtureUrl = new URL("../../../tests/fixtures/tavily.json", import.meta.url);

function cancelTrackedStream(
  chunks: Uint8Array[] = [],
  closeDelayMs?: number,
  cancelImpl?: () => void | Promise<void>,
): { stream: ReadableStream<Uint8Array>; cancelSpy: ReturnType<typeof vi.fn> } {
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSpy = vi.fn(async (_reason?: unknown) => {
    await cancelImpl?.();
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (closeDelayMs !== undefined) {
        closeTimer = setTimeout(() => controller.close(), closeDelayMs);
      }
    },
    cancel(reason) {
      if (closeTimer) clearTimeout(closeTimer);
      return cancelSpy(reason);
    },
  });
  return { stream, cancelSpy };
}

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

  it("cancels non-success bodies without allowing cancel errors to replace the status", async () => {
    const { stream, cancelSpy } = cancelTrackedStream([], undefined, async () => {
      throw new Error("cancel failed");
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 503 }));

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(/503/);
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it("cancels non-JSON response bodies", async () => {
    const { stream, cancelSpy } = cancelTrackedStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(/JSON/i);
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it("sanitizes invalid JSON errors when the response body contains the API key", async () => {
    const sentinel = "invalid-json-key-sentinel";
    const fetchImpl = vi.fn(
      async () =>
        new Response(`{"api_key":"${sentinel}",`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    let rejection: unknown;
    try {
      await searchNews("bitcoin", sentinel, fetchImpl);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const exposedError = rejection as Error;
    expect(exposedError.message).toBe("Tavily returned invalid JSON");
    expect(exposedError.cause).toBeUndefined();
    expect(JSON.stringify(exposedError)).not.toContain(sentinel);
    expect(JSON.stringify({
      message: exposedError.message,
      cause: exposedError.cause,
    })).not.toContain(sentinel);
  });

  it("cancels bodies rejected by the Content-Length limit", async () => {
    const body = new TextEncoder().encode("{}");
    const { stream, cancelSpy } = cancelTrackedStream([body], 25);
    const fetchImpl = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(512 * 1024 + 1),
          },
        }),
    );

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(
      "Tavily response is too large",
    );
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response exceeding 512 KiB", async () => {
    const oversizedChunk = new Uint8Array(512 * 1024 + 1).fill(97);
    const { stream, cancelSpy } = cancelTrackedStream([oversizedChunk], 25);
    const fetchImpl = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(searchNews("bitcoin", "key", fetchImpl)).rejects.toThrow(
      "Tavily response is too large",
    );
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it.each([
    { results: [{ title: "", url: "https://example.com", content: "empty title" }] },
    { results: [{ title: "Title", url: "   ", content: "empty URL" }] },
    { results: [{ title: "Title", url: "file:///tmp/result", content: "bad URL" }] },
    { results: [{ title: "Title", url: "https://example.com", content: 42 }] },
    { results: [{ title: "Title", url: "https://example.com", content: "   " }] },
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
