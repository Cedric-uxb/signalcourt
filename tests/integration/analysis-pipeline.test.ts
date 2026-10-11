import { expect, it } from "vitest";

import { receiptSchema, type Receipt } from "../../src/shared/contracts.js";
import { sha256 } from "../../src/server/domain/canonical-json.js";
import { createDemoDependencies } from "../../src/server/analysis/demo-fixture.js";
import {
  createAnalysisPipeline,
  receiptIntegrityPayload,
  replayReceipt,
} from "../../src/server/analysis/pipeline.js";

const input = {
  articleUrl: "https://example.com/sol-news",
  token: " sol ",
  riskLevel: "balanced",
} as const;

function updateClaimCausalEntry(receipt: Receipt, index: number) {
  const claim = receipt.claims[index]!;
  receipt.causalChain[index] = `claim:${claim.id}:${claim.status}:${sha256({
    text: claim.text,
    evidenceIds: claim.evidenceIds,
    explanation: claim.explanation,
  })}`;
}

function updateArgumentCausalEntry(receipt: Receipt) {
  receipt.causalChain[receipt.causalChain.length - 1] =
    `arguments:${sha256(receipt.arguments)}`;
}

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
  expect(receipt.replay.receiptHash).toBe(
    sha256(receiptIntegrityPayload(receipt)),
  );
  expect(replayReceipt(receipt)).toEqual({
    evidenceHash: receipt.replay.evidenceHash,
    identical: true,
  });
  expect(JSON.stringify(receipt)).toContain("Demo/Simulated");
  expect(receipt.evidence.filter(({ kind }) => kind === "ryo").map(({ payload }) =>
    (payload as { availability: unknown }).availability
  )).toEqual([
    { market: "available" },
    { market: "available", technicals: "available" },
    { primary: "available", derivatives: "available" },
    { sentiment: "available" },
  ]);
});

it("requires a stored full receipt integrity hash for replay", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const { receiptHash: _receiptHash, ...incompleteReplay } = receipt.replay;

  expect(replayReceipt({ ...receipt, replay: incompleteReplay })).toEqual({
    evidenceHash: "",
    identical: false,
  });
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

it("replay detects news changed to the article publisher even with fresh hashes", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  const news = tampered.evidence.find(({ id }) => id === "news-1")!;
  news.source = "https://www.example.com/other";
  if (typeof news.payload === "object" && news.payload !== null) {
    (news.payload as { url: string }).url = news.source;
  }
  const { hash: _hash, ...partial } = news;
  news.hash = sha256(partial);
  tampered.replay.evidenceHash = sha256(tampered.evidence);

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});

it.each(["ryo-1", "ryo-3", "ryo-4"])(
  "replay detects invalid required data in %s even with fresh hashes",
  async (evidenceId) => {
    const receipt = await createAnalysisPipeline(
      createDemoDependencies("supported"),
    ).run(input);
    const tampered = structuredClone(receipt);
    const evidence = tampered.evidence.find(({ id }) => id === evidenceId)!;
    (evidence.payload as { data: unknown }).data = null;
    const { hash: _hash, ...partial } = evidence;
    evidence.hash = sha256(partial);
    tampered.replay.evidenceHash = sha256(tampered.evidence);

    expect(receiptSchema.safeParse(tampered).success).toBe(true);
    expect(replayReceipt(tampered).identical).toBe(false);
  },
);

it("rejects duplicate evidence ids even when the added news is otherwise independent", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  const original = tampered.evidence.find(({ id }) => id === "news-1")!;
  const duplicate = structuredClone(original);
  duplicate.source = "https://example.net/another-report";
  const payload = duplicate.payload as {
    url: string;
    publisher: { domain: string; id: string };
  };
  payload.url = duplicate.source;
  payload.publisher = { domain: "example.net", id: "another-publisher" };
  const { hash: _duplicateHash, ...duplicatePartial } = duplicate;
  duplicate.hash = sha256(duplicatePartial);
  tampered.evidence.push(duplicate);
  tampered.replay.evidenceHash = sha256(tampered.evidence);

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});

it("rejects duplicate claim ids after causal data is recomputed", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  tampered.claims.push(structuredClone(tampered.claims[0]!));
  tampered.causalChain.splice(
    tampered.causalChain.length - 1,
    0,
    tampered.causalChain[0]!,
  );

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});

it("rejects a claim evidence reference that does not exist", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  tampered.claims[0]!.evidenceIds = ["news-missing"];
  updateClaimCausalEntry(tampered, 0);

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});

it("rejects duplicate evidence references within one claim", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  tampered.claims[0]!.evidenceIds = ["news-1", "news-1"];
  updateClaimCausalEntry(tampered, 0);

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});

it("rejects duplicate citations within one debate argument", async () => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("supported"),
  ).run(input);
  const tampered = structuredClone(receipt);
  tampered.arguments[0].citations.push(tampered.arguments[0].citations[0]!);
  updateArgumentCausalEntry(tampered);

  expect(receiptSchema.safeParse(tampered).success).toBe(true);
  expect(replayReceipt(tampered).identical).toBe(false);
});

it.each([
  {
    name: "article URL",
    mutate: (receipt: Receipt) => {
      receipt.input.articleUrl = "https://example.com/different-news";
    },
  },
  {
    name: "token",
    mutate: (receipt: Receipt) => {
      receipt.input.token = "ETH";
    },
  },
  {
    name: "risk level",
    mutate: (receipt: Receipt) => {
      receipt.input.riskLevel = "aggressive";
    },
  },
  {
    name: "model name",
    mutate: (receipt: Receipt) => {
      receipt.model.name = "tampered-model";
    },
  },
  {
    name: "prompt version",
    mutate: (receipt: Receipt) => {
      receipt.model.promptVersion = "tampered-prompt";
    },
  },
  {
    name: "receipt id",
    mutate: (receipt: Receipt) => {
      receipt.id = "tampered-id";
    },
  },
  {
    name: "creation time",
    mutate: (receipt: Receipt) => {
      receipt.createdAt = "2026-10-08T12:00:01.000Z";
    },
  },
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
  {
    name: "causal chain",
    mutate: (receipt: Receipt) => {
      receipt.causalChain[0] = "tampered-causal-entry";
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
