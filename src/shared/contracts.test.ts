import { describe, expect, it } from "vitest";

import { evidenceSchema, receiptSchema } from "./contracts.js";

const evidence = {
  id: "evidence-1",
  hash: "a".repeat(64),
  kind: "article" as const,
  source: "https://example.com/article",
  retrievedAt: "2026-10-11T12:00:00.000Z",
  observedAt: null,
  status: "ok" as const,
  dataMode: "live" as const,
  payload: { title: "Market update", values: [1, true, null] },
  summary: "Market update summary",
  warnings: [],
};

const bullArgument = {
  stance: "bull" as const,
  thesis: "Supporting evidence is stronger",
  confidence: 0.7,
  citations: ["evidence-1"],
};

const bearArgument = {
  stance: "bear" as const,
  thesis: "Downside uncertainty remains",
  confidence: 0.3,
  citations: ["evidence-1"],
};

const receipt = {
  schemaVersion: "1.0" as const,
  id: "receipt-1",
  createdAt: "2026-10-11T12:00:00.000Z",
  input: {
    articleUrl: "https://example.com/article",
    token: "BTC",
    riskLevel: "balanced" as const,
  },
  evidence: [evidence],
  claims: [],
  arguments: [bullArgument, bearArgument],
  verdict: "NO_TRADE" as const,
  confidence: 0,
  reasonCodes: [],
  causalChain: [],
  riskPlan: null,
  model: { name: "fixture", promptVersion: "test" },
  replay: { evidenceHash: "hash", identical: true },
};

describe("evidenceSchema", () => {
  it("rejects an undefined payload", () => {
    expect(evidenceSchema.safeParse({ ...evidence, payload: undefined }).success).toBe(
      false,
    );
  });

  it("accepts a JSON payload after serialization round-trip", () => {
    const serialized = JSON.stringify(evidence.payload);
    const roundTrippedPayload: unknown = JSON.parse(serialized);

    const result = evidenceSchema.safeParse({
      ...evidence,
      payload: roundTrippedPayload,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual(evidence.payload);
    }
  });
});

describe("receiptSchema", () => {
  it("rejects two bull arguments", () => {
    expect(
      receiptSchema.safeParse({
        ...receipt,
        arguments: [bullArgument, bullArgument],
      }).success,
    ).toBe(false);
  });

  it("accepts arguments ordered bull then bear", () => {
    expect(receiptSchema.safeParse(receipt).success).toBe(true);
  });
});
