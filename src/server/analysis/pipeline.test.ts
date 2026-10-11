import { expect, it, vi } from "vitest";

import { receiptSchema, type Argument } from "../../shared/contracts.js";
import { sha256 } from "../domain/canonical-json.js";
import {
  canonicalizeSourceUrl,
  createAnalysisPipeline,
  publisherKey,
  replayReceipt,
  type AnalysisDependencies,
  type ClaimVerification,
  type RyoResult,
  type VerificationNewsEvidence,
} from "./pipeline.js";

const FIXED_TIME = "2026-10-08T12:00:00.000Z";

function ryoArguments(tool: string): Record<string, unknown> {
  if (tool === "analyze_token") return { symbol: "SOL" };
  if (tool === "deep_analysis") return { symbol: "SOL", include_perp: true };
  if (tool === "monitor_market_sentiment_shift") return { time_window: "7d" };
  return {};
}

const requiredAvailability: Readonly<Record<string, readonly string[]>> = {
  market_overview: ["market"],
  analyze_token: ["market", "technicals"],
  deep_analysis: ["primary", "derivatives"],
  monitor_market_sentiment_shift: ["sentiment"],
};

function usableAvailability(tool: string): Record<string, unknown> {
  return Object.fromEntries(
    requiredAvailability[tool]!.map((key) => [key, "available"]),
  );
}

function ryoResult(tool: string): RyoResult {
  return {
    tool,
    status: "ok",
    dataMode: "live",
    asOf: FIXED_TIME,
    request: ryoArguments(tool),
    data: tool === "analyze_token"
      ? { market: { price_usd: 100 }, technicals: { atr_14: 5 } }
      : { available: true },
    availability: usableAvailability(tool),
    summary: `${tool} available`,
    warnings: [],
  };
}

function verification(
  claimId: string,
  status: ClaimVerification["status"] = "verified",
  evidenceIds = status === "unsupported" ? [] : ["news-1"],
): ClaimVerification {
  return {
    claimId,
    status,
    evidenceIds,
    explanation: `${claimId} is ${status}.`,
  };
}

function argument(
  stance: "bull" | "bear",
  confidence = stance === "bull" ? 0.8 : 0.4,
  citations = ["article-1"],
): Argument {
  return {
    stance,
    thesis: `${stance} thesis`,
    confidence,
    citations,
  };
}

function makeDependencies(
  overrides: Partial<AnalysisDependencies> = {},
): AnalysisDependencies {
  return {
    articleFetcher: vi.fn(async (url: string) => ({
      url,
      text: "SOL issuer confirms a regulated market filing.",
    })),
    newsSearcher: vi.fn(async () => [{
      title: "Independent filing report",
      url: "https://example.org/filing",
      excerpt: "A public register lists the filing.",
    }]),
    ryo: { call: vi.fn(async (tool: string) => ryoResult(tool)) },
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [{
        id: "claim-1",
        text: "A regulated market filing was submitted.",
      }]),
      verifyClaims: vi.fn(async (claims: Array<{ id: string; text: string }>) =>
        claims.map(({ id }) => verification(id))),
      argue: vi.fn(async (stance: "bull" | "bear") => argument(stance)),
    },
    now: vi.fn(() => new Date(FIXED_TIME)),
    id: vi.fn(() => "receipt-1"),
    publisherRegistry: {
      "example.com": "fixture-origin",
      "example.org": "fixture-independent",
    },
    ...overrides,
  };
}

const rawInput = {
  articleUrl: "https://example.com/news",
  token: "SOL",
  riskLevel: "balanced",
} as const;

it("canonicalizes source URLs before comparing publishers", () => {
  expect(canonicalizeSourceUrl(
    "HTTPS://ExAmPle.com:443/a/../news?utm_source=x&b=2&gclid=y&a=1#section",
  )).toBe("https://example.com/news?a=1&b=2");
  expect(publisherKey("https://www.news.Example.com/story")).toBe("example.com");
  expect(publisherKey("https://news.bbc.co.uk/story")).toBe("bbc.co.uk");
  expect(publisherKey("https://192.0.2.10/story")).toBeNull();
  expect(publisherKey("http://localhost/story")).toBeNull();
});

it.each([
  ["the exact article URL", "https://example.com/news"],
  [
    "an article URL with tracking and a fragment",
    "https://EXAMPLE.com:443/news?utm_source=feed&fbclid=abc#section",
  ],
  ["a www host from the same publisher", "https://www.example.com/other"],
  ["a subdomain from the same base publisher", "https://press.example.com/other"],
])("filters %s before claim verification", async (_name, url) => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{
      title: "Not independent",
      url,
      excerpt: "This source is not independent from the article.",
    }]),
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
  expect(receipt.claims[0]).toMatchObject({
    status: "unsupported",
    evidenceIds: [],
  });
  expect(verifyClaims).not.toHaveBeenCalled();
  expect(receipt.evidence.filter(({ kind }) => kind === "news")).toHaveLength(0);
});

it("keeps only the first news item from a duplicate publisher", async () => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{
      title: "First independent report",
      url: "https://wire.example.org/first",
      excerpt: "First report.",
    }, {
      title: "Second report from same publisher",
      url: "https://www.example.org/second",
      excerpt: "Duplicate publisher report.",
    }]),
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("LONG");
  expect(receipt.evidence.filter(({ kind }) => kind === "news")).toHaveLength(1);
  expect(verifyClaims).toHaveBeenCalledWith(
    expect.any(Array),
    [expect.objectContaining({ id: "news-1", title: "First independent report" })],
  );
});

it("rejects cross-domain news registered to the article publisher", async () => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{
      title: "BBC UK report",
      url: "https://www.bbc.co.uk/news/story",
      excerpt: "A report from another BBC domain.",
    }]),
    publisherRegistry: {
      "bbc.com": " bbc ",
      "bbc.co.uk": "bbc",
    },
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run({
    ...rawInput,
    articleUrl: "https://www.bbc.com/news/story",
  });

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
  expect(verifyClaims).not.toHaveBeenCalled();
});

it("fails closed when distinct domains are absent from the publisher registry", async () => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    publisherRegistry: {},
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
  expect(verifyClaims).not.toHaveBeenCalled();
});

it("defaults an omitted publisher registry to empty", async () => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    llm: { ...makeDependencies().llm, verifyClaims },
  });
  delete dependencies.publisherRegistry;

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(verifyClaims).not.toHaveBeenCalled();
});

it("treats a blank registry publisher id as unregistered", async () => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    publisherRegistry: {
      "example.com": "origin",
      "example.org": "   ",
    },
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(verifyClaims).not.toHaveBeenCalled();
});

it("accepts distinct registered publisher identities", async () => {
  const receipt = await createAnalysisPipeline(makeDependencies({
    publisherRegistry: {
      "example.com": "origin",
      "example.org": "public-register",
    },
  })).run(rawInput);

  expect(receipt.verdict).toBe("LONG");
  expect(receipt.claims[0]).toMatchObject({
    status: "verified",
    evidenceIds: ["news-1"],
  });
});

it("uses the PSL to keep distinct registered co.uk publishers", async () => {
  const verifyClaims = vi.fn(async (
    claims: Array<{ id: string }>,
    news: VerificationNewsEvidence[],
  ) =>
    claims.map(({ id }) => verification(id, "verified", news.map(({ id }) => id)))
  );
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{
      title: "BBC report",
      url: "https://news.bbc.co.uk/story",
      excerpt: "BBC report excerpt.",
    }, {
      title: "Independent report",
      url: "https://www.independent.co.uk/story",
      excerpt: "Independent report excerpt.",
    }]),
    publisherRegistry: {
      "example.com": "origin",
      "bbc.co.uk": "bbc",
      "independent.co.uk": "independent",
    },
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("LONG");
  expect(receipt.evidence.filter(({ kind }) => kind === "news")).toHaveLength(2);
  expect(verifyClaims.mock.calls[0]?.[1].map(({ url }) => url)).toEqual([
    "https://news.bbc.co.uk/story",
    "https://www.independent.co.uk/story",
  ]);
});

it("deduplicates cross-domain news with the same registered publisher id", async () => {
  const verifyClaims = vi.fn(async (
    _claims: Array<{ id: string }>,
    _news: VerificationNewsEvidence[],
  ) => [verification("claim-1")]);
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{
      title: "BBC US report",
      url: "https://www.bbc.com/story",
      excerpt: "First BBC report.",
    }, {
      title: "BBC UK report",
      url: "https://www.bbc.co.uk/story",
      excerpt: "Second BBC report.",
    }]),
    publisherRegistry: {
      "example.com": "origin",
      "bbc.com": "bbc",
      "bbc.co.uk": "bbc",
    },
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("LONG");
  expect(receipt.evidence.filter(({ kind }) => kind === "news")).toHaveLength(1);
  expect(verifyClaims.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining({ title: "BBC US report", id: "news-1" }),
  ]);
});

it.each([
  "http://127.0.0.1/report",
  "http://localhost/report",
])("does not accept %s as independent news", async (url) => {
  const verifyClaims = vi.fn(async () => [verification("claim-1")]);
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{ title: "Local", url, excerpt: "Local." }]),
    publisherRegistry: {
      "example.com": "origin",
      "127.0.0.1": "local-ip",
      localhost: "local-host",
    },
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(verifyClaims).not.toHaveBeenCalled();
});

async function rejectionSnapshot(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      message: error.message,
      cause: error.cause,
      serialized: JSON.stringify(error),
    };
  }
}

it("returns NO_TRADE when independent news is unavailable", async () => {
  const dependencies = makeDependencies({ newsSearcher: vi.fn(async () => []) });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toEqual([
    "CLAIM_UNSUPPORTED",
    "INSUFFICIENT_EVIDENCE",
  ]);
  expect(receipt.claims[0]).toMatchObject({
    status: "unsupported",
    evidenceIds: [],
  });
  expect(dependencies.llm.verifyClaims).not.toHaveBeenCalled();
});

it("uses per-claim verification instead of treating unrelated news as support", async () => {
  const verifyClaims = vi.fn(async () => [
    verification("claim-1", "unsupported"),
  ]);
  const dependencies = makeDependencies({
    llm: { ...makeDependencies().llm, verifyClaims },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("CLAIM_UNSUPPORTED");
  expect(receipt.claims).toEqual([
    expect.objectContaining({
      id: "claim-1",
      status: "unsupported",
      evidenceIds: [],
    }),
  ]);
  expect(verifyClaims).toHaveBeenCalledWith(
    [{ id: "claim-1", text: "A regulated market filing was submitted." }],
    [{
      id: "news-1",
      title: "Independent filing report",
      url: "https://example.org/filing",
      excerpt: "A public register lists the filing.",
    }],
  );
});

it("returns CLAIM_DISPUTED when independent news contradicts a claim", async () => {
  const dependencies = makeDependencies({
    llm: {
      ...makeDependencies().llm,
      verifyClaims: vi.fn(async () => [
        verification("claim-1", "disputed", ["news-1"]),
      ]),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("CLAIM_DISPUTED");
  expect(receipt.claims[0]).toMatchObject({
    status: "disputed",
    evidenceIds: ["news-1"],
  });
});

it("allows a verified claim to reach the supported LONG decision", async () => {
  const receipt = await createAnalysisPipeline(makeDependencies()).run(rawInput);

  expect(receipt).toMatchObject({
    verdict: "LONG",
    reasonCodes: [],
    claims: [{ status: "verified", evidenceIds: ["news-1"] }],
  });
});

it.each([
  {
    name: "unknown evidence id",
    claims: [{ id: "claim-1", text: "Claim one" }],
    output: [verification("claim-1", "verified", ["news-999"])],
  },
  {
    name: "missing claim",
    claims: [
      { id: "claim-1", text: "Claim one" },
      { id: "claim-2", text: "Claim two" },
    ],
    output: [verification("claim-1")],
  },
  {
    name: "duplicate claim",
    claims: [
      { id: "claim-1", text: "Claim one" },
      { id: "claim-2", text: "Claim two" },
    ],
    output: [verification("claim-1"), verification("claim-1")],
  },
])("fails closed for verifier output with $name", async ({ claims, output }) => {
  const dependencies = makeDependencies({
    llm: {
      ...makeDependencies().llm,
      extractClaims: vi.fn(async () => claims),
      verifyClaims: vi.fn(async () => output),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("MODEL_UNAVAILABLE");
  expect(receipt.claims).toEqual(claims.map((claim) => ({
    ...claim,
    status: "unsupported",
    evidenceIds: [],
    explanation: "Claim verification is unavailable.",
  })));
});

it("fails closed when claim verification throws without leaking the error", async () => {
  const dependencies = makeDependencies({
    llm: {
      ...makeDependencies().llm,
      verifyClaims: vi.fn(() => {
        throw new Error("raw verifier secret");
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("MODEL_UNAVAILABLE");
  expect(receipt.claims[0]).toMatchObject({
    status: "unsupported",
    evidenceIds: [],
  });
  expect(JSON.stringify(receipt)).not.toContain("raw verifier secret");
});

it("fails closed when news search throws without leaking the error", async () => {
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => {
      throw new Error("secret upstream details");
    }),
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);
  const serialized = JSON.stringify(receipt);
  const newsEvidence = receipt.evidence.find(({ kind }) => kind === "news");

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toEqual([
    "CLAIM_UNSUPPORTED",
    "INSUFFICIENT_EVIDENCE",
  ]);
  expect(newsEvidence).toMatchObject({
    id: "news-1",
    status: "unavailable",
    dataMode: "unknown",
  });
  expect(serialized).not.toContain("secret upstream details");
});

it.each([
  "market_overview",
  "analyze_token",
  "deep_analysis",
  "monitor_market_sentiment_shift",
])("converts a %s failure into auditable unavailable evidence", async (failedTool) => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => {
        if (tool === failedTool) throw new Error("private RYO failure");
        return ryoResult(tool);
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);
  const failedEvidence = receipt.evidence.find(({ source }) => source === failedTool);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("MARKET_DATA_UNAVAILABLE");
  expect(failedEvidence).toMatchObject({
    status: "unavailable",
    dataMode: "unknown",
  });
  expect(JSON.stringify(receipt)).not.toContain("private RYO failure");
  if (failedTool === "analyze_token") {
    expect(receipt.reasonCodes).toEqual([
      "MARKET_DATA_UNAVAILABLE",
      "RISK_INPUT_INCOMPLETE",
    ]);
  }
});

it.each(["simulated", "mixed", "unknown"] as const)(
  "blocks %s RYO data in live evidence mode",
  async (dataMode) => {
    const dependencies = makeDependencies({
      ryo: {
        call: vi.fn(async (tool: string) => ({
          ...ryoResult(tool),
          dataMode,
        })),
      },
    });

    const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

    expect(receipt.verdict).toBe("NO_TRADE");
    expect(receipt.reasonCodes).toContain("MARKET_DATA_UNAVAILABLE");
  },
);

it("preserves validated RYO request, data, and availability provenance", async () => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => tool === "analyze_token"
        ? {
            ...ryoResult(tool),
            request: { symbol: "SOL", endpoint: "fixture" },
          }
        : ryoResult(tool)),
    },
  });
  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);
  const tokenEvidence = receipt.evidence.find(({ id }) => id === "ryo-2");

  expect(tokenEvidence?.payload).toEqual({
    request: { symbol: "SOL", endpoint: "fixture" },
    data: { market: { price_usd: 100 }, technicals: { atr_14: 5 } },
    availability: { market: "available", technicals: "available" },
  });
  expect(receipt.verdict).toBe("LONG");
});

it.each([
  ["market_overview", "request"],
  ["market_overview", "availability"],
  ["analyze_token", "request"],
  ["analyze_token", "availability"],
  ["deep_analysis", "request"],
  ["deep_analysis", "availability"],
  ["monitor_market_sentiment_shift", "request"],
  ["monitor_market_sentiment_shift", "availability"],
] as const)("fails closed when %s omits required %s provenance", async (
  failedTool,
  missingField,
) => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => {
        const result = ryoResult(tool);
        if (tool !== failedTool) return result;
        const invalid: Partial<RyoResult> = { ...result };
        delete invalid[missingField];
        return invalid as RyoResult;
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);
  const failedEvidence = receipt.evidence.find(({ source }) => source === failedTool);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("MARKET_DATA_UNAVAILABLE");
  expect(failedEvidence).toMatchObject({
    status: "unavailable",
    dataMode: "unknown",
    payload: {
      request: ryoArguments(failedTool),
      availability: Object.fromEntries(
        requiredAvailability[failedTool]!.map((key) => [key, false]),
      ),
    },
  });
  expect(failedEvidence?.summary).toContain("Pipeline fallback");
});

it.each([
  ["analyze_token", { symbol: "ETH" }],
  ["monitor_market_sentiment_shift", { time_window: "1d" }],
] as const)("fails closed for mismatched %s request provenance", async (failedTool, request) => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => tool === failedTool
        ? { ...ryoResult(tool), request }
        : ryoResult(tool)),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("MARKET_DATA_UNAVAILABLE");
  expect(receipt.evidence.find(({ source }) => source === failedTool))
    .toMatchObject({ status: "unavailable", dataMode: "unknown" });
});

const invalidAvailabilityCases = Object.entries(requiredAvailability).flatMap(
  ([tool, keys]) => {
    const valid = usableAvailability(tool);
    const [requiredKey] = keys;
    const missing = { ...valid };
    delete missing[requiredKey!];
    return [
      [tool, "missing required key", missing],
      [tool, "false required key", { ...valid, [requiredKey!]: false }],
      [tool, "unavailable required key", {
        ...valid,
        [requiredKey!]: "unavailable",
      }],
      [tool, "legacy ok required key", { ...valid, [requiredKey!]: "ok" }],
      [tool, "only unrelated metadata", { unrelated_metadata: "available" }],
    ] as const;
  },
);

it("accepts true or available for every required availability key", async () => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => {
        const availability = usableAvailability(tool);
        const [firstKey] = requiredAvailability[tool]!;
        availability[firstKey!] = true;
        return { ...ryoResult(tool), availability };
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("LONG");
  expect(replayReceipt(receipt).identical).toBe(true);
});

it.each(invalidAvailabilityCases)(
  "blocks %s with %s availability",
  async (failedTool, _name, availability) => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => tool === failedTool
        ? { ...ryoResult(tool), availability }
        : ryoResult(tool)),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("MARKET_DATA_UNAVAILABLE");
  expect(replayReceipt(receipt).identical).toBe(true);
  },
);

it.each([
  ["exactly 24 hours old", "2026-10-07T12:00:00.000Z", "LONG"],
  ["24 hours and 1ms old", "2026-10-07T11:59:59.999Z", "NO_TRADE"],
  ["exactly 5 minutes ahead", "2026-10-08T12:05:00.000Z", "LONG"],
  ["5 minutes and 1ms ahead", "2026-10-08T12:05:00.001Z", "NO_TRADE"],
] as const)("applies the RYO freshness boundary at %s", async (_name, asOf, verdict) => {
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn(async (tool: string) => ({ ...ryoResult(tool), asOf })),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe(verdict);
  expect(receipt.reasonCodes.includes("MARKET_DATA_UNAVAILABLE"))
    .toBe(verdict === "NO_TRADE");
  expect(replayReceipt(receipt).identical).toBe(true);
});

it("starts all RYO requests concurrently while preserving evidence order", async () => {
  const tools = [
    "market_overview",
    "analyze_token",
    "deep_analysis",
    "monitor_market_sentiment_shift",
  ];
  const calls: string[] = [];
  const deferred = new Map<string, {
    promise: Promise<RyoResult>;
    resolve: (value: RyoResult) => void;
  }>();
  for (const tool of tools) {
    let resolve!: (value: RyoResult) => void;
    const promise = new Promise<RyoResult>((resolver) => {
      resolve = resolver;
    });
    deferred.set(tool, { promise, resolve });
  }
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn((tool: string) => {
        calls.push(tool);
        return deferred.get(tool)!.promise;
      }),
    },
  });

  const run = createAnalysisPipeline(dependencies).run(rawInput);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const callsBeforeRelease = [...calls];
  for (const tool of tools) deferred.get(tool)!.resolve(ryoResult(tool));
  const receipt = await run;

  expect(callsBeforeRelease).toEqual([
    "market_overview",
    "analyze_token",
    "deep_analysis",
    "monitor_market_sentiment_shift",
  ]);
  expect(receipt.evidence.filter(({ kind }) => kind === "ryo").map(({ source }) => source))
    .toEqual(callsBeforeRelease);
});

it("isolates synchronous and asynchronous RYO failures", async () => {
  const calls: string[] = [];
  const dependencies = makeDependencies({
    ryo: {
      call: vi.fn((tool: string): Promise<RyoResult> => {
        calls.push(tool);
        if (tool === "market_overview") throw new Error("sync RYO secret");
        if (tool === "analyze_token") return Promise.reject(new Error("async RYO secret"));
        return Promise.resolve(ryoResult(tool));
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);
  const ryoEvidence = receipt.evidence.filter(({ kind }) => kind === "ryo");

  expect(calls).toHaveLength(4);
  expect(ryoEvidence.map(({ status }) => status)).toEqual([
    "unavailable",
    "unavailable",
    "ok",
    "ok",
  ]);
  expect(JSON.stringify(receipt)).not.toMatch(/sync RYO secret|async RYO secret/);
});

it("fails closed for invalid news and mismatched RYO dependency outputs", async () => {
  const dependencies = makeDependencies({
    newsSearcher: vi.fn(async () => [{
      title: "",
      url: "javascript:alert(1)",
      excerpt: "",
    }]),
    ryo: {
      call: vi.fn(async (tool: string) => ({
        ...ryoResult(tool),
        tool: tool === "deep_analysis" ? "analyze_token" : tool,
      })),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toEqual([
    "CLAIM_UNSUPPORTED",
    "MARKET_DATA_UNAVAILABLE",
    "INSUFFICIENT_EVIDENCE",
  ]);
  expect(receipt.evidence.find(({ source }) => source === "deep_analysis"))
    .toMatchObject({ status: "unavailable", dataMode: "unknown" });
});

it("rejects an invalid article dependency output at the pipeline boundary", async () => {
  const dependencies = makeDependencies({
    articleFetcher: vi.fn(async () => ({
      url: "file:///tmp/article",
      text: "",
    })),
  });

  await expect(createAnalysisPipeline(dependencies).run(rawInput))
    .rejects.toThrow("Article evidence unavailable");
  expect(dependencies.llm.extractClaims).not.toHaveBeenCalled();
});

it.each([
  {
    name: "synchronous throw",
    articleFetcher: () => {
      throw new Error("sync article sentinel");
    },
    sentinel: "sync article sentinel",
  },
  {
    name: "asynchronous rejection",
    articleFetcher: () => Promise.reject(new Error("async article sentinel")),
    sentinel: "async article sentinel",
  },
])("sanitizes an articleFetcher $name", async ({ articleFetcher, sentinel }) => {
  const dependencies = makeDependencies({ articleFetcher });

  const error = await rejectionSnapshot(
    createAnalysisPipeline(dependencies).run(rawInput),
  );

  expect(error).toEqual({
    message: "Article evidence unavailable",
    cause: undefined,
    serialized: "{}",
  });
  expect(JSON.stringify(error)).not.toContain(sentinel);
});

it("sanitizes clock, model, and receipt id stage failures", async () => {
  const clockDependencies = makeDependencies({
    now: vi.fn(() => {
      throw new Error("clock secret");
    }),
  });
  const modelDependencies = makeDependencies();
  Object.defineProperty(modelDependencies.llm, "model", {
    get() {
      throw new Error("model secret");
    },
  });
  const idDependencies = makeDependencies({
    id: vi.fn(() => {
      throw new Error("id secret");
    }),
  });

  const snapshots = await Promise.all([
    rejectionSnapshot(createAnalysisPipeline(clockDependencies).run(rawInput)),
    rejectionSnapshot(createAnalysisPipeline(modelDependencies).run(rawInput)),
    rejectionSnapshot(createAnalysisPipeline(idDependencies).run(rawInput)),
  ]);

  expect(snapshots.map(({ message }) => message)).toEqual([
    "Analysis clock failed",
    "Model configuration is invalid",
    "Receipt id generation failed",
  ]);
  expect(snapshots.every(({ cause }) => cause === undefined)).toBe(true);
  expect(JSON.stringify(snapshots)).not.toMatch(/clock secret|model secret|id secret/);
});

it.each(["", "x".repeat(129)])(
  "rejects invalid generated receipt id %j with a fixed error",
  async (id) => {
    const error = await rejectionSnapshot(
      createAnalysisPipeline(makeDependencies({ id: vi.fn(() => id) })).run(rawInput),
    );

    expect(error.message).toBe("Receipt id generation failed");
    expect(error.cause).toBeUndefined();
  },
);

it("returns NO_TRADE when either argument contains a missing citation", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [{ id: "claim-1", text: "Claim" }]),
      verifyClaims: vi.fn(async (claims: Array<{ id: string; text: string }>) =>
        claims.map(({ id }) => verification(id))),
      argue: vi.fn(async (stance: "bull" | "bear") =>
        argument(stance, stance === "bull" ? 0.8 : 0.4, [
          stance === "bull" ? "missing-1" : "article-1",
        ])),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toEqual(["CITATION_INVALID"]);
  expect(receipt.riskPlan).toBeNull();
});

it("returns NO_TRADE without a risk plan when confidence is tied", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [{ id: "claim-1", text: "Claim" }]),
      verifyClaims: vi.fn(async (claims: Array<{ id: string; text: string }>) =>
        claims.map(({ id }) => verification(id))),
      argue: vi.fn(async (stance: "bull" | "bear") => argument(stance, 0.5)),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt).toMatchObject({
    verdict: "NO_TRADE",
    confidence: 0,
    reasonCodes: [],
    riskPlan: null,
  });
});

it("uses deterministic arguments and reason ordering when claim extraction fails", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => {
        throw new Error("raw model extraction failure");
      }),
      verifyClaims: vi.fn(async () => []),
      argue: vi.fn(async (stance: "bull" | "bear") => argument(stance)),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt).toMatchObject({
    verdict: "NO_TRADE",
    confidence: 0,
    claims: [],
    arguments: [
      { stance: "bull", confidence: 0, citations: ["article-1"] },
      { stance: "bear", confidence: 0, citations: ["article-1"] },
    ],
    reasonCodes: [
      "CLAIM_UNSUPPORTED",
      "MODEL_UNAVAILABLE",
      "INSUFFICIENT_EVIDENCE",
    ],
    riskPlan: null,
  });
  expect(JSON.stringify(receipt)).not.toContain("raw model extraction failure");
  expect(dependencies.newsSearcher).not.toHaveBeenCalled();
  expect(dependencies.llm.argue).not.toHaveBeenCalled();
});

it("fails closed when one debate side throws or returns an invalid argument", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [{ id: "claim-1", text: "Claim" }]),
      verifyClaims: vi.fn(async (claims: Array<{ id: string; text: string }>) =>
        claims.map(({ id }) => verification(id))),
      argue: vi.fn(async (stance: "bull" | "bear") => {
        if (stance === "bull") throw new Error("raw bull failure");
        return { ...argument("bear"), stance: "bull" } as Argument;
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt).toMatchObject({
    verdict: "NO_TRADE",
    confidence: 0,
    reasonCodes: ["MODEL_UNAVAILABLE"],
    riskPlan: null,
    arguments: [
      { stance: "bull", confidence: 0, citations: ["article-1"] },
      { stance: "bear", confidence: 0, citations: ["article-1"] },
    ],
  });
  expect(JSON.stringify(receipt)).not.toContain("raw bull failure");
});

it.each(["bull", "bear"] as const)(
  "contains a synchronous %s argument failure and still triggers both sides",
  async (failedStance) => {
    const rawError = `raw synchronous ${failedStance} failure`;
    const argue = vi.fn(
      (stance: "bull" | "bear"): Promise<Argument> => {
        if (stance === failedStance) throw new Error(rawError);
        return Promise.resolve(argument(stance));
      },
    );
    const dependencies = makeDependencies({
      llm: {
        model: "fixture-model",
        extractClaims: vi.fn(async () => [{ id: "claim-1", text: "Claim" }]),
        verifyClaims: vi.fn(async (claims: Array<{ id: string; text: string }>) =>
          claims.map(({ id }) => verification(id))),
        argue,
      },
    });

    const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

    expect(receiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt).toMatchObject({
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes: ["MODEL_UNAVAILABLE"],
      riskPlan: null,
      arguments: [
        { stance: "bull", confidence: 0, citations: ["article-1"] },
        { stance: "bear", confidence: 0, citations: ["article-1"] },
      ],
    });
    expect(argue.mock.calls.map(([stance]) => stance)).toEqual(["bull", "bear"]);
    expect(JSON.stringify(receipt)).not.toContain(rawError);
  },
);

it("validates extracted claims for limits, uniqueness, and nonempty text", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [
        { id: "duplicate", text: "Claim one" },
        { id: "duplicate", text: "Claim two" },
      ]),
      verifyClaims: vi.fn(async () => []),
      argue: vi.fn(async (stance: "bull" | "bear") => argument(stance)),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(receipt.claims).toEqual([]);
  expect(receipt.reasonCodes).toEqual([
    "CLAIM_UNSUPPORTED",
    "MODEL_UNAVAILABLE",
    "INSUFFICIENT_EVIDENCE",
  ]);
});

it("keeps evidence hashes deterministic and does not share mutations across runs", async () => {
  const first = await createAnalysisPipeline(makeDependencies({
    id: vi.fn(() => "receipt-a"),
  })).run(rawInput);
  const second = await createAnalysisPipeline(makeDependencies({
    id: vi.fn(() => "receipt-b"),
  })).run(rawInput);

  expect(first.id).not.toBe(second.id);
  expect(first.replay.evidenceHash).toBe(second.replay.evidenceHash);
  expect(first.evidence.every(({ hash, ...partial }) => hash === sha256(partial)))
    .toBe(true);

  first.evidence[0]!.warnings.push("mutated first receipt");
  expect(second.evidence[0]!.warnings).toEqual([]);
});

it("gives bull and bear independent deeply frozen evidence snapshots", async () => {
  let bullSnapshotFrozen = false;
  let bearObservedWarnings: string[] | undefined;
  const dependencies = makeDependencies({
    llm: {
      ...makeDependencies().llm,
      argue: vi.fn((stance: "bull" | "bear", evidence) => {
        if (stance === "bull") {
          bullSnapshotFrozen = Object.isFrozen(evidence) &&
            Object.isFrozen(evidence[0]) &&
            Object.isFrozen(evidence[0]!.warnings);
          evidence[0]!.warnings.push("bull mutation");
        }
        bearObservedWarnings = [...evidence[0]!.warnings];
        return Promise.resolve(argument(stance));
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);

  expect(bullSnapshotFrozen).toBe(true);
  expect(bearObservedWarnings).toEqual([]);
  expect(receipt.evidence[0]!.warnings).toEqual([]);
  expect(receipt.reasonCodes).toContain("MODEL_UNAVAILABLE");
  expect(receipt.evidence.every(({ hash, ...partial }) => hash === sha256(partial)))
    .toBe(true);
});

it("gives the verifier a deeply frozen snapshot without exposing final evidence", async () => {
  let verifierSnapshotFrozen = false;
  const dependencies = makeDependencies({
    llm: {
      ...makeDependencies().llm,
      verifyClaims: vi.fn((claims, news) => {
        verifierSnapshotFrozen = Object.isFrozen(claims) &&
          Object.isFrozen(claims[0]) &&
          Object.isFrozen(news) &&
          Object.isFrozen(news[0]);
        news[0]!.title = "mutated title";
        return Promise.resolve([verification("claim-1")]);
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run(rawInput);
  const newsEvidence = receipt.evidence.find(({ id }) => id === "news-1");

  expect(verifierSnapshotFrozen).toBe(true);
  expect(newsEvidence?.summary).toBe("A public register lists the filing.");
  expect(receipt.reasonCodes).toContain("MODEL_UNAVAILABLE");
});

it("uses one timestamp and calls RYO tools with fixed ordered arguments", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const now = vi.fn(() => new Date(FIXED_TIME));
  const dependencies = makeDependencies({
    now,
    ryo: {
      call: vi.fn(async (tool: string, arguments_: Record<string, unknown>) => {
        calls.push([tool, arguments_]);
        return ryoResult(tool);
      }),
    },
  });

  const receipt = await createAnalysisPipeline(dependencies).run({
    ...rawInput,
    token: " sol ",
  });

  expect(now).toHaveBeenCalledTimes(1);
  expect(receipt.createdAt).toBe(FIXED_TIME);
  expect(receipt.evidence.every(({ retrievedAt }) => retrievedAt === FIXED_TIME))
    .toBe(true);
  expect(receipt.input.token).toBe("SOL");
  expect(calls).toEqual([
    ["market_overview", {}],
    ["analyze_token", { symbol: "SOL" }],
    ["deep_analysis", { symbol: "SOL", include_perp: true }],
    ["monitor_market_sentiment_shift", { time_window: "7d" }],
  ]);
});

it("rejects an invalid timestamp with a stable error before fetching", async () => {
  const dependencies = makeDependencies({ now: vi.fn(() => new Date("invalid")) });

  await expect(createAnalysisPipeline(dependencies).run(rawInput))
    .rejects.toThrow("Analysis timestamp is invalid");
  expect(dependencies.articleFetcher).not.toHaveBeenCalled();
});

it("rejects raw invalid input before calling any dependency", async () => {
  const dependencies = makeDependencies();

  await expect(createAnalysisPipeline(dependencies).run({
    ...rawInput,
    articleUrl: "file:///tmp/news",
  })).rejects.toThrow();

  expect(dependencies.now).not.toHaveBeenCalled();
  expect(dependencies.articleFetcher).not.toHaveBeenCalled();
  expect(dependencies.newsSearcher).not.toHaveBeenCalled();
  expect(dependencies.ryo.call).not.toHaveBeenCalled();
  expect(dependencies.llm.extractClaims).not.toHaveBeenCalled();
  expect(dependencies.llm.argue).not.toHaveBeenCalled();
});

it("returns receipts that satisfy the shared contract", async () => {
  const receipt = await createAnalysisPipeline(makeDependencies()).run(rawInput);

  expect(receiptSchema.safeParse(receipt).success).toBe(true);
  expect(replayReceipt(receipt)).toEqual({
    evidenceHash: receipt.replay.evidenceHash,
    identical: true,
  });
});
