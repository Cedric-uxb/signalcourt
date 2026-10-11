import { expect, it } from "vitest";

import { receiptSchema, type Receipt } from "../../src/shared/contracts.js";
import { sha256 } from "../../src/server/domain/canonical-json.js";
import { createDemoDependencies } from "../../src/server/analysis/demo-fixture.js";
import {
  createAnalysisPipeline,
  replayReceipt,
} from "../../src/server/analysis/pipeline.js";

const input = {
  articleUrl: "https://example.com/sol-news",
  token: " sol ",
  riskLevel: "balanced",
} as const;

it("creates a replayable supported simulated decision receipt offline", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);

  expect(receiptSchema.safeParse(receipt).success).toBe(true);
  expect(receipt).toMatchObject({
    id: "demo-supported",
    createdAt: "2026-10-08T12:00:00.000Z",
    input: { ...input, token: "SOL" },
    verdict: "LONG",
    confidence: 0.8,
    reasonCodes: [],
    riskPlan: {
      entry: 100,
      stop: 90,
      target: 115,
      practiceSizeUsd: 100,
    },
    replay: { identical: true },
  });
  expect(receipt.evidence).toHaveLength(6);
  expect(receipt.evidence.every(({ dataMode }) => dataMode === "simulated"))
    .toBe(true);
  expect(receipt.evidence.every(({ hash, ...partial }) => hash === sha256(partial)))
    .toBe(true);
  expect(receipt.replay.evidenceHash).toBe(sha256(receipt.evidence));
  expect(replayReceipt(receipt)).toEqual({
    evidenceHash: receipt.replay.evidenceHash,
    identical: true,
  });
  expect(JSON.stringify(receipt)).toContain("Demo/Simulated");
});

it("creates an offline insufficient-evidence receipt without claiming live data", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("insufficient"),
  ).run(input);

  expect(receiptSchema.safeParse(receipt).success).toBe(true);
  expect(receipt.id).toBe("demo-insufficient");
  expect(receipt.verdict).toBe("NO_TRADE");
  expect(receipt.reasonCodes).toContain("CLAIM_UNSUPPORTED");
  expect(receipt.claims).toEqual([
    expect.objectContaining({ status: "unsupported", evidenceIds: [] }),
  ]);
  expect(receipt.evidence.every(({ dataMode }) => dataMode !== "live")).toBe(true);
  expect(replayReceipt(receipt).identical).toBe(true);
});

it.each([
  {
    name: "evidence payload",
    mutate: (receipt: Receipt) => {
      receipt.evidence[0]!.payload = "tampered payload";
    },
  },
  {
    name: "evidence hash",
    mutate: (receipt: Receipt) => {
      receipt.evidence[0]!.hash = "0".repeat(64);
    },
  },
  {
    name: "claims",
    mutate: (receipt: Receipt) => {
      receipt.claims[0]!.status = "unsupported";
      receipt.claims[0]!.evidenceIds = [];
    },
  },
  {
    name: "arguments",
    mutate: (receipt: Receipt) => {
      receipt.arguments[0].confidence = 0.1;
    },
  },
  {
    name: "decision",
    mutate: (receipt: Receipt) => {
      receipt.confidence = 0.7;
    },
  },
])("detects replay tampering in $name", async ({ mutate }) => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  mutate(tampered);

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});
