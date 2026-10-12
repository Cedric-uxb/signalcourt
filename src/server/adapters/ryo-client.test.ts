import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createRyoClient } from "./ryo-client.js";

const fixtureCases = [
  {
    file: "ryo-market-overview.json",
    tool: "market_overview",
    arguments: {},
    status: "ok",
    dataMode: "simulated",
    summary: "Demo market regime is neutral",
    warnings: [],
  },
  {
    file: "ryo-analyze-token.json",
    tool: "analyze_token",
    arguments: { symbol: "SOL" },
    status: "ok",
    dataMode: "mixed",
    summary: "Demo token momentum is balanced",
    warnings: [],
  },
  {
    file: "ryo-deep-analysis.json",
    tool: "deep_analysis",
    arguments: { symbol: "SOL", include_perp: true },
    status: "partial",
    dataMode: "unknown",
    summary: "Demo evidence is mixed",
    warnings: ["Demo derivatives source unavailable", "Data mode could not be verified"],
  },
  {
    file: "ryo-sentiment.json",
    tool: "monitor_market_sentiment_shift",
    arguments: { time_window: "7d" },
    status: "unavailable",
    dataMode: "simulated",
    summary: "Demo sentiment source is unavailable",
    warnings: ["Demo sentiment source unavailable"],
  },
] as const;

function fixtureUrl(file: string): URL {
  return new URL(`../../../tests/fixtures/${file}`, import.meta.url);
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function validPayload(tool = "analyze_token", request: Record<string, unknown> = { symbol: "SOL" }) {
  return {
    result: {
      schema_version: "1",
      tool,
      status: "ok",
      data_mode: "live",
      as_of: "2026-10-08T12:00:00.000Z",
      request,
      data: { price_usd: 100 },
      summary: { headline: "Current response is valid" },
      availability: { market: "available" },
      warnings: [],
    },
  };
}

function errorSnapshot(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return {
    message: error.message,
    cause: error.cause === undefined ? undefined : errorSnapshot(error.cause),
  };
}

function cancelTrackedStream(
  chunks: Uint8Array[] = [],
  cancelImpl?: () => void | Promise<void>,
): { stream: ReadableStream<Uint8Array>; cancelSpy: ReturnType<typeof vi.fn> } {
  const cancelSpy = vi.fn(async (_reason?: unknown) => {
    await cancelImpl?.();
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel(reason) {
      return cancelSpy(reason);
    },
  });
  return { stream, cancelSpy };
}

function clientWith(
  fetchImpl: typeof fetch,
  sleepImpl = vi.fn(async (_ms: number) => {}),
  nowImpl?: () => number,
) {
  return createRyoClient({
    baseUrl: "https://api.example.test/mcp///",
    apiKey: `  ${["fixture", "credential"].join("-")}  `,
    fetchImpl,
    sleepImpl,
    ...(nowImpl ? { nowImpl } : {}),
  });
}

describe("createRyoClient", () => {
  it.each([
    "",
    "   ",
    "not a URL",
    "http://api.example.test/mcp",
    "ftp://api.example.test/mcp",
    "https://user@api.example.test/mcp",
    "https://user:pass@api.example.test/mcp",
    "https://api.example.test/mcp?key=value",
    "https://api.example.test/mcp#fragment",
  ])("rejects invalid base URL %j", (baseUrl) => {
    expect(() => createRyoClient({ baseUrl, apiKey: "key", fetchImpl: vi.fn() })).toThrow(
      /base URL/i,
    );
  });

  it.each(["", "   "])("rejects empty API key %j without fetching", (apiKey) => {
    const fetchImpl = vi.fn();

    expect(() =>
      createRyoClient({ baseUrl: "https://api.example.test", apiKey, fetchImpl }),
    ).toThrow(/API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose the API key in constructor errors", () => {
    const sentinel = "constructor-key-sentinel";

    expect(() => createRyoClient({ baseUrl: "invalid", apiKey: sentinel })).not.toThrow(sentinel);
  });
});

describe("RYO catalog", () => {
  it("gets the normalized catalog URL with bearer auth and a timeout", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ tools: [{ name: "analyze_token" }] }),
    );

    const catalog = await clientWith(fetchImpl).catalog();

    expect(catalog).toEqual({ tools: [{ name: "analyze_token" }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl).toBe("https://api.example.test/mcp/tools");
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer fixture-credential" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeUndefined();
    expect(String(requestUrl)).not.toContain("fixture-credential");
  });

  it.each([[], null, "tools", 42])("rejects a non-object catalog payload %#", async (payload) => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow(/catalog schema/i);
  });

  it.each([
    ["missing tools", {}],
    ["error payload", { error: "unavailable" }],
    ["unsafe tool name", { tools: [{ name: "../admin" }] }],
  ])("rejects catalog contract violation: %s", async (_name, payload) => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow(/catalog schema/i);
  });

  it("trims tool names while preserving forward-compatible catalog metadata", async () => {
    const payload = {
      tools: [
        {
          name: "  analyze_token  ",
          description: "Analyze a token",
          input_schema: { type: "object" },
        },
      ],
      catalog_version: "2026-10",
    };
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(clientWith(fetchImpl).catalog()).resolves.toEqual({
      tools: [
        {
          name: "analyze_token",
          description: "Analyze a token",
          input_schema: { type: "object" },
        },
      ],
      catalog_version: "2026-10",
    });
  });

  it("creates a fresh 15-second timeout for every attempt", async () => {
    const responses = [new Response(null, { status: 503 }), jsonResponse({ tools: [] })];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    try {
      await clientWith(fetchImpl).catalog();
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 15_000);
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 15_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("RYO call normalization", () => {
  it.each(fixtureCases)("normalizes $file without changing evidence state", async (fixture) => {
    const body = await readFile(fixtureUrl(fixture.file), "utf8");
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    );

    const result = await clientWith(fetchImpl).call(fixture.tool, fixture.arguments);

    expect(result).toMatchObject({
      tool: fixture.tool,
      status: fixture.status,
      dataMode: fixture.dataMode,
      asOf: "2026-10-08T12:00:00.000Z",
      request: fixture.arguments,
      summary: fixture.summary,
      warnings: [...fixture.warnings],
    });
  });

  it("posts JSON arguments to the encoded tool URL with bearer auth and a timeout", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(validPayload()),
    );

    await clientWith(fetchImpl).call("  analyze_token  ", { symbol: "SOL" });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl).toBe("https://api.example.test/mcp/tools/analyze_token/call");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-credential",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ symbol: "SOL" }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(requestUrl)).not.toContain("fixture-credential");
    expect(String(init?.body)).not.toContain("fixture-credential");
  });

  it.each(["", "   ", "../tools", "a/b", "a?x", "a#x", "a b", ".", "tool%2Fname"])(
    "rejects unsafe tool name %j",
    async (tool) => {
      const fetchImpl = vi.fn();

      await expect(clientWith(fetchImpl).call(tool, {})).rejects.toThrow(/tool/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["undefined", undefined],
    ["array", []],
    ["string", "SOL"],
    ["bigint", { amount: 1n }],
  ])("rejects non-JSON object arguments: %s", async (_name, arguments_) => {
    const fetchImpl = vi.fn();

    await expect(
      clientWith(fetchImpl).call("analyze_token", arguments_ as Record<string, unknown>),
    ).rejects.toThrow(/arguments/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects circular arguments", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fetchImpl = vi.fn();

    await expect(clientWith(fetchImpl).call("analyze_token", circular)).rejects.toThrow(
      /arguments/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a response for a different tool", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validPayload("deep_analysis")));

    await expect(clientWith(fetchImpl).call("analyze_token", {})).rejects.toThrow(/tool mismatch/i);
  });

  it.each([
    ["symbol", { symbol: "SOL" }, { symbol: "BTC" }],
    ["time window", { time_window: "7d" }, { time_window: "24h" }],
  ])("rejects a response with mismatched %s request evidence", async (_name, sent, received) => {
    const fetchImpl = vi.fn(async () => jsonResponse(validPayload("analyze_token", received)));

    await expect(clientWith(fetchImpl).call("analyze_token", sent)).rejects.toThrow(
      "RYO response request mismatch",
    );
  });

  it("accepts equivalent nested request objects with different key order", async () => {
    const sent = {
      filters: { chain: "solana", thresholds: { high: 2, low: 1 } },
      assets: ["SOL", "BTC"],
    };
    const received = {
      assets: ["SOL", "BTC"],
      filters: { thresholds: { low: 1, high: 2 }, chain: "solana" },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(validPayload("analyze_token", received)));

    await expect(clientWith(fetchImpl).call("analyze_token", sent)).resolves.toMatchObject({
      request: received,
    });
  });

  it("accepts response request fields added as server defaults", async () => {
    const received = { symbol: "SOL", currency: "USD" };
    const fetchImpl = vi.fn(async () => jsonResponse(validPayload("analyze_token", received)));

    await expect(
      clientWith(fetchImpl).call("analyze_token", { symbol: "SOL" }),
    ).resolves.toMatchObject({ request: received });
  });

  it.each([
    ["top-level", (payload: ReturnType<typeof validPayload>) => Object.assign(payload, { extra: true })],
    ["result", (payload: ReturnType<typeof validPayload>) => Object.assign(payload.result, { extra: true })],
    [
      "summary",
      (payload: ReturnType<typeof validPayload>) =>
        Object.assign(payload.result.summary, { extra: true }),
    ],
  ])("rejects an unknown %s response field", async (_location, mutate) => {
    const payload = validPayload();
    mutate(payload);
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(clientWith(fetchImpl).call("analyze_token", {})).rejects.toThrow(
      /response schema/i,
    );
  });

  it.each([
    ["schema version", { schema_version: "999" }],
    ["status", { status: "success" }],
    ["data mode", { data_mode: "fresh" }],
    ["date", { as_of: "October 8" }],
    ["warnings", { warnings: ["first", 2] }],
    ["headline", { summary: { headline: "   " } }],
    ["request scalar", { request: "SOL" }],
    ["data", { data: undefined }],
    ["availability scalar", { availability: "available" }],
    ["availability", { availability: undefined }],
  ])("rejects invalid result schema: %s", async (_name, change) => {
    const payload = validPayload();
    Object.assign(payload.result, change);
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(clientWith(fetchImpl).call("analyze_token", {})).rejects.toThrow(
      /response schema/i,
    );
  });
});

describe("RYO bounded retries", () => {
  it.each([429, 503])("retries status %s at most three total attempts", async (status) => {
    const responses = [
      new Response(null, { status }),
      new Response(null, { status }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await expect(clientWith(fetchImpl, sleepImpl).call("analyze_token", {})).resolves.toMatchObject({
      tool: "analyze_token",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200]);
  });

  it("uses non-negative Retry-After seconds and caps server delay at five seconds", async () => {
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "0" } }),
      new Response(null, { status: 503, headers: { "retry-after": "3600" } }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await clientWith(fetchImpl, sleepImpl).call("analyze_token", {});

    expect(sleepImpl.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([0, 5_000]);
  });

  it("accepts Retry-After delay-seconds with leading zeros", async () => {
    const responses = [
      new Response(null, { status: 503, headers: { "retry-after": "001" } }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await clientWith(fetchImpl, sleepImpl).call("analyze_token", {});

    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(1_000);
  });

  it("caps arbitrarily large Retry-After delay-seconds", async () => {
    const responses = [
      new Response(null, { status: 503, headers: { "retry-after": "9".repeat(400) } }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await clientWith(fetchImpl, sleepImpl).call("analyze_token", {});

    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(5_000);
  });

  it.each([
    ["future date above cap", 10_000, 5_000],
    ["future date under cap", 3_000, 3_000],
    ["past date", -1_000, 0],
  ])("uses Retry-After HTTP-date for %s", async (_name, offsetMs, expectedDelay) => {
    const now = Date.parse("2026-10-11T12:00:00.000Z");
    const responses = [
      new Response(null, {
        status: 503,
        headers: { "retry-after": new Date(now + offsetMs).toUTCString() },
      }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await clientWith(fetchImpl, sleepImpl, () => now).call("analyze_token", {});

    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(expectedDelay);
  });

  it("falls back to exponential delay for fractional Retry-After seconds", async () => {
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "0.5" } }),
      new Response(null, { status: 503, headers: { "retry-after": "1.25" } }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await clientWith(fetchImpl, sleepImpl).call("analyze_token", {});

    expect(sleepImpl.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200]);
  });

  it("falls back to exponential delay for invalid Retry-After values", async () => {
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "-1" } }),
      new Response(null, { status: 503, headers: { "retry-after": "later" } }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await clientWith(fetchImpl, sleepImpl).call("analyze_token", {});

    expect(sleepImpl.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200]);
  });

  it("does not sleep after the final retryable response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await expect(clientWith(fetchImpl, sleepImpl).catalog()).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry or sleep for other error statuses", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const sleepImpl = vi.fn(async (_ms: number) => {});

    await expect(clientWith(fetchImpl, sleepImpl).catalog()).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("cancels each retry body before sleeping", async () => {
    const first = cancelTrackedStream();
    const second = cancelTrackedStream();
    const responses = [
      new Response(first.stream, { status: 429 }),
      new Response(second.stream, { status: 503 }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleepImpl = vi.fn(async () => {});

    await clientWith(fetchImpl, sleepImpl).call("analyze_token", {});

    expect(first.cancelSpy).toHaveBeenCalledOnce();
    expect(second.cancelSpy).toHaveBeenCalledOnce();
    expect(first.cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      sleepImpl.mock.invocationCallOrder[0]!,
    );
    expect(second.cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      sleepImpl.mock.invocationCallOrder[1]!,
    );
  });

  it("ignores retry cancellation failures without replacing the eventual result", async () => {
    const retry = cancelTrackedStream([], async () => {
      throw new Error("cancel failed");
    });
    const responses = [
      new Response(retry.stream, { status: 503 }),
      jsonResponse(validPayload()),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);

    await expect(clientWith(fetchImpl).call("analyze_token", {})).resolves.toMatchObject({
      tool: "analyze_token",
    });
    expect(retry.cancelSpy).toHaveBeenCalledOnce();
  });

  it("sanitizes now hook errors after cancelling the retry body", async () => {
    const sentinel = "now-hook-key-sentinel";
    const retry = cancelTrackedStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(retry.stream, {
          status: 503,
          headers: { "retry-after": "Sun, 11 Oct 2026 12:00:03 GMT" },
        }),
    );
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const client = createRyoClient({
      baseUrl: "https://api.example.test",
      apiKey: sentinel,
      fetchImpl,
      sleepImpl,
      nowImpl: () => {
        throw new Error(`clock leaked ${sentinel}`, { cause: { sentinel } });
      },
    });

    let rejection: unknown;
    try {
      await client.catalog();
    } catch (error) {
      rejection = error;
    }

    expect(errorSnapshot(rejection)).toEqual({
      message: "RYO retry scheduling failed",
      cause: undefined,
    });
    expect(JSON.stringify(errorSnapshot(rejection))).not.toContain(sentinel);
    expect(JSON.stringify(rejection)).not.toContain(sentinel);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(retry.cancelSpy).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("sanitizes sleep hook errors after cancelling the retry body", async () => {
    const sentinel = "sleep-hook-key-sentinel";
    const retry = cancelTrackedStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(retry.stream, { status: 429, headers: { "retry-after": "1" } }),
    );
    const client = createRyoClient({
      baseUrl: "https://api.example.test",
      apiKey: sentinel,
      fetchImpl,
      sleepImpl: async () => {
        throw new Error(`sleep leaked ${sentinel}`, { cause: { sentinel } });
      },
    });

    let rejection: unknown;
    try {
      await client.catalog();
    } catch (error) {
      rejection = error;
    }

    expect(errorSnapshot(rejection)).toEqual({
      message: "RYO retry scheduling failed",
      cause: undefined,
    });
    expect(JSON.stringify(errorSnapshot(rejection))).not.toContain(sentinel);
    expect(JSON.stringify(rejection)).not.toContain(sentinel);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(retry.cancelSpy).toHaveBeenCalledOnce();
  });
});

describe("RYO response failures", () => {
  it("sanitizes transport errors and does not retry them", async () => {
    const sentinel = "transport-key-sentinel";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`socket failed with ${sentinel}`, { cause: sentinel });
    });
    const client = createRyoClient({
      baseUrl: "https://api.example.test",
      apiKey: sentinel,
      fetchImpl,
      sleepImpl: vi.fn(async () => {}),
    });

    let rejection: unknown;
    try {
      await client.catalog();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const exposedError = rejection as Error;
    expect(exposedError.message).toBe("RYO request failed");
    expect(exposedError.cause).toBeUndefined();
    expect(JSON.stringify(exposedError)).not.toContain(sentinel);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels non-success bodies even when cancellation rejects", async () => {
    const failed = cancelTrackedStream([], async () => {
      throw new Error("cancel failed");
    });
    const fetchImpl = vi.fn(async () => new Response(failed.stream, { status: 401 }));

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow(/401/);
    expect(failed.cancelSpy).toHaveBeenCalledOnce();
  });

  it("rejects and cancels a non-JSON content type", async () => {
    const body = cancelTrackedStream();
    const fetchImpl = vi.fn(
      async () => new Response(body.stream, { headers: { "content-type": "text/plain" } }),
    );

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow(/must be JSON/i);
    expect(body.cancelSpy).toHaveBeenCalledOnce();
  });

  it("rejects invalid JSON without exposing response content", async () => {
    const sentinel = "invalid-json-key-sentinel";
    const fetchImpl = vi.fn(
      async () =>
        new Response(`{"secret":"${sentinel}",`, {
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow("RYO returned invalid JSON");
    try {
      await clientWith(fetchImpl).catalog();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  });

  it("rejects an empty response body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { headers: { "content-type": "application/json" } }),
    );

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow(/empty/i);
  });

  it("cancels a response rejected by Content-Length", async () => {
    const body = cancelTrackedStream([new TextEncoder().encode("{}")]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body.stream, {
          headers: {
            "content-type": "application/json",
            "content-length": String(512 * 1024 + 1),
          },
        }),
    );

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow("RYO response is too large");
    expect(body.cancelSpy).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response exceeding 512 KiB", async () => {
    const body = cancelTrackedStream([new Uint8Array(512 * 1024 + 1).fill(97)]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body.stream, { headers: { "content-type": "application/json" } }),
    );

    await expect(clientWith(fetchImpl).catalog()).rejects.toThrow("RYO response is too large");
    expect(body.cancelSpy).toHaveBeenCalledOnce();
  });
});
