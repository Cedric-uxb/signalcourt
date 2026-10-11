import { expect, it, vi } from "vitest";

import { receiptSchema, type Argument } from "../../shared/contracts.js";
import { sha256 } from "../domain/canonical-json.js";
import {
  createAnalysisPipeline,
  type AnalysisDependencies,
  type RyoResult,
} from "./pipeline.js";

const FIXED_TIME = "2026-10-08T12:00:00.000Z";

function ryoResult(tool: string): RyoResult {
  return {
    tool,
    status: "ok",
    dataMode: "live",
    asOf: FIXED_TIME,
    data: tool === "analyze_token"
      ? { market: { price_usd: 100 }, technicals: { atr_14: 5 } }
      : { available: true },
    summary: `${tool} available`,
    warnings: [],
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
      argue: vi.fn(async (stance: "bull" | "bear") => argument(stance)),
    },
    now: vi.fn(() => new Date(FIXED_TIME)),
    id: vi.fn(() => "receipt-1"),
    ...overrides,
  };
}

const rawInput = {
  articleUrl: "https://example.com/news",
  token: "SOL",
  riskLevel: "balanced",
} as const;

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

  await expect(createAnalysisPipeline(dependencies).run(rawInput)).rejects.toThrow();
  expect(dependencies.llm.extractClaims).not.toHaveBeenCalled();
});

it("returns NO_TRADE when either argument contains a missing citation", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [{ id: "claim-1", text: "Claim" }]),
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

it("validates extracted claims for limits, uniqueness, and nonempty text", async () => {
  const dependencies = makeDependencies({
    llm: {
      model: "fixture-model",
      extractClaims: vi.fn(async () => [
        { id: "duplicate", text: "Claim one" },
        { id: "duplicate", text: "Claim two" },
      ]),
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
});
