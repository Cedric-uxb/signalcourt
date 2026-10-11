import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { receiptSchema, type Receipt } from "../shared/contracts.js";
import { createDemoDependencies } from "./analysis/demo-fixture.js";
import { createAnalysisPipeline } from "./analysis/pipeline.js";
import { buildApp, type AppOptions } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase } from "./persistence/database.js";

const validInput = {
  articleUrl: "https://example.com/sol-news",
  token: "SOL",
  riskLevel: "balanced",
} as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function demoReceipt(id = "receipt-fixture"): Promise<Receipt> {
  const dependencies = createDemoDependencies("supported");
  return createAnalysisPipeline({ ...dependencies, id: () => id }).run(validInput);
}

async function legacyReceipt(id = "legacy-receipt"): Promise<Receipt> {
  const current = await demoReceipt(id);
  const { receiptHash: _receiptHash, ...replay } = current.replay;
  return receiptSchema.parse({
    ...current,
    schemaVersion: "1.0",
    replay,
  });
}

function repositoryFor(receipt: Receipt | null = null) {
  return {
    insert: vi.fn(),
    findById: vi.fn(() => receipt),
  };
}

function completeLiveEnv(
  publisherRegistry: Readonly<Record<string, string>> = {
    "one.example": "publisher-one",
    "two.example": "publisher-two",
  },
): NodeJS.ProcessEnv {
  return {
    RYO_MCP_KEY: "ryo-key",
    TAVILY_API_KEY: "tavily-key",
    LLM_BASE_URL: "https://llm.example.test/v1",
    LLM_API_KEY: "llm-key",
    LLM_MODEL: "model",
    PUBLISHER_REGISTRY_JSON: JSON.stringify(publisherRegistry),
  };
}

describe("GET /api/health", () => {
  it("returns the SignalCourt service status", async () => {
    const app = buildApp({ env: {}, databasePath: ":memory:" });

    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        service: "signalcourt",
        version: "0.1.0",
      });
    } finally {
      await app.close();
    }
  });
});

describe("analysis and receipt routes", () => {
  it("creates, retrieves, and genuinely replays a demo receipt", async () => {
    const app = buildApp({ mode: "demo", env: {}, databasePath: ":memory:" });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/analyses",
        payload: validInput,
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const receipt = created.json<Receipt>();

      const fetched = await app.inject({
        method: "GET",
        url: `/api/receipts/${receipt.id}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.headers["cache-control"]).toBe("no-store");
      expect(fetched.json()).toEqual(receipt);

      const replay = await app.inject({
        method: "POST",
        url: `/api/receipts/${receipt.id}/replay`,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.headers["cache-control"]).toBe("no-store");
      expect(replay.json()).toEqual({
        id: receipt.id,
        identical: true,
        evidenceHash: receipt.replay.evidenceHash,
      });
    } finally {
      await app.close();
    }
  });

  it("creates a fresh demo receipt id for every request and stores both", async () => {
    const ids = ["demo-request-1", "demo-request-2"];
    const app = buildApp({
      mode: "demo",
      env: {},
      databasePath: ":memory:",
      idGenerator: () => ids.shift() ?? "unexpected-id",
    });

    try {
      const first = await app.inject({ method: "POST", url: "/api/analyses", payload: validInput });
      const second = await app.inject({ method: "POST", url: "/api/analyses", payload: validInput });
      const firstReceipt = first.json<Receipt>();
      const secondReceipt = second.json<Receipt>();

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(firstReceipt.id).not.toBe(secondReceipt.id);

      for (const id of [firstReceipt.id, secondReceipt.id]) {
        const fetched = await app.inject({ method: "GET", url: `/api/receipts/${id}` });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json<Receipt>().id).toBe(id);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a runtime dependency override", () => {
    const unsafeOptions = {
      mode: "demo",
      env: {},
      dependencies: createDemoDependencies("supported"),
    } as unknown as AppOptions;

    expect(() => buildApp(unsafeOptions)).toThrow("Unsupported app override");
  });

  it("never emits live RYO evidence in demo mode", async () => {
    const app = buildApp({ mode: "demo", env: {}, databasePath: ":memory:" });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/analyses",
        payload: validInput,
      });
      const receipt = response.json<Receipt>();

      expect(response.statusCode).toBe(201);
      expect(receipt.evidence.filter(({ kind }) => kind === "ryo"))
        .not.toHaveLength(0);
      expect(receipt.evidence.filter(({ kind }) => kind === "ryo")
        .every(({ dataMode }) => dataMode === "simulated")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns NO_TRADE for the insufficient demo scenario", async () => {
    const app = buildApp({
      mode: "demo",
      demoScenario: "insufficient",
      env: {},
      databasePath: ":memory:",
    });

    try {
      const response = await app.inject({ method: "POST", url: "/api/analyses", payload: validInput });

      expect(response.statusCode).toBe(201);
      expect(response.json<Receipt>()).toMatchObject({
        verdict: "NO_TRADE",
        riskPlan: null,
      });
      expect(response.json<Receipt>().reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
    } finally {
      await app.close();
    }
  });

  it.each([
    "%20",
    "%20receipt",
    `${"a".repeat(129)}`,
    "receipt%00id",
    "receipt%0Aid",
    "receipt%2Fid",
    "receipt%25id",
    "%E2%98%83",
  ])(
    "rejects invalid receipt id %j",
    async (id) => {
      const repository = repositoryFor();
      const app = buildApp({ env: {}, repository });

      try {
        for (const method of ["GET", "POST"] as const) {
          const suffix = method === "POST" ? "/replay" : "";
          const response = await app.inject({ method, url: `/api/receipts/${id}${suffix}` });
          expect(response.statusCode).toBe(400);
          expect(response.json()).toEqual({ error: "INVALID_RECEIPT_ID" });
        }
        expect(repository.findById).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each(["550e8400-e29b-41d4-a716-446655440000", "demo-supported_1.2"])(
    "accepts safe receipt id %j for lookup and replay",
    async (id) => {
      const receipt = await demoReceipt(id);
      const repository = repositoryFor(receipt);
      const app = buildApp({ env: {}, repository });

      try {
        const fetched = await app.inject({ method: "GET", url: `/api/receipts/${id}` });
        const replay = await app.inject({ method: "POST", url: `/api/receipts/${id}/replay` });

        expect(fetched.statusCode).toBe(200);
        expect(replay.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  it("returns 404 for a valid missing receipt", async () => {
    const app = buildApp({ env: {}, repository: repositoryFor() });

    try {
      for (const [method, suffix] of [["GET", ""], ["POST", "/replay"]] as const) {
        const response = await app.inject({ method, url: `/api/receipts/missing${suffix}` });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "RECEIPT_NOT_FOUND" });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await app.close();
    }
  });

  it("redacts repository failures", async () => {
    const sentinel = "repository-secret-value";
    const repository = {
      insert: vi.fn(),
      findById: vi.fn(() => { throw new Error(sentinel); }),
    };
    const app = buildApp({ env: {}, repository });

    try {
      for (const [method, suffix] of [["GET", ""], ["POST", "/replay"]] as const) {
        const response = await app.inject({ method, url: `/api/receipts/receipt-1${suffix}` });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: "RECEIPT_UNAVAILABLE" });
        expect(response.body).not.toContain(sentinel);
      }
    } finally {
      await app.close();
    }
  });

  it("uses Task8 replay logic to detect a schema-valid tampered receipt", async () => {
    const original = await demoReceipt();
    const tampered: Receipt = { ...original, verdict: "SHORT" };
    const app = buildApp({
      env: {},
      repository: repositoryFor(tampered),
    });

    try {
      const response = await app.inject({ method: "POST", url: `/api/receipts/${tampered.id}/replay` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: tampered.id,
        identical: false,
        evidenceHash: original.replay.evidenceHash,
      });
    } finally {
      await app.close();
    }
  });

  it("returns an unchanged legacy receipt and reports replay as non-identical", async () => {
    const receipt = await legacyReceipt();
    const app = buildApp({ env: {}, repository: repositoryFor(receipt) });

    try {
      const fetched = await app.inject({
        method: "GET",
        url: `/api/receipts/${receipt.id}`,
      });
      const replay = await app.inject({
        method: "POST",
        url: `/api/receipts/${receipt.id}/replay`,
      });

      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toEqual(receipt);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({
        id: receipt.id,
        evidenceHash: receipt.replay.evidenceHash,
        identical: false,
      });
    } finally {
      await app.close();
    }
  });
});

describe("system capabilities and application lifecycle", () => {
  it("reports demo capabilities without exposing partial keys", async () => {
    const sentinel = "partial-system-secret";
    const app = buildApp({
      env: {
        RYO_MCP_KEY: sentinel,
        PUBLISHER_REGISTRY_JSON: JSON.stringify({
          "one.example": "publisher-one",
          "two.example": "publisher-two",
        }),
      },
      databasePath: ":memory:",
    });

    try {
      const response = await app.inject({ method: "GET", url: "/api/system" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        mode: "demo",
        capabilities: { ryo: false, news: false, model: false },
        demoAvailable: true,
        publisherRegistryConfigured: true,
      });
      expect(response.body).not.toContain(sentinel);
    } finally {
      await app.close();
    }
  });

  it("reports live capabilities without making a network request", async () => {
    const app = buildApp({
      env: completeLiveEnv(),
      mode: "live",
      databasePath: ":memory:",
    });

    try {
      const response = await app.inject({ method: "GET", url: "/api/system" });

      expect(response.json()).toEqual({
        mode: "live",
        capabilities: { ryo: true, news: true, model: true },
        demoAvailable: true,
        publisherRegistryConfigured: true,
      });
      expect(response.body).not.toContain("ryo-key");
      expect(response.body).not.toContain("llm-key");
    } finally {
      await app.close();
    }
  });

  it("rejects a live override when required config is missing", () => {
    expect(() => buildApp({ mode: "live", env: {}, databasePath: ":memory:" }))
      .toThrow("Live dependencies are not configured");
  });

  it("closes a persistent database so it can be reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "signalcourt-app-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "receipts.sqlite");
    const app = buildApp({ env: {}, databasePath });

    try {
      await app.ready();
    } finally {
      await app.close();
    }

    const reopened = openDatabase(databasePath);
    try {
      expect(reopened.open).toBe(true);
      expect(reopened.prepare("SELECT COUNT(*) FROM receipts").pluck().get()).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("closes an opened database when pipeline assembly fails", () => {
    const db = openDatabase(":memory:");
    const config = readConfig(completeLiveEnv());
    const invalidConfig = {
      ...config,
      publisherRegistry: new Proxy({}, {
        ownKeys() {
          throw new Error("forced pipeline assembly failure");
        },
      }),
    };

    expect(() => buildApp({
      config: invalidConfig,
      db,
      repository: repositoryFor(),
    })).toThrow();
    expect(db.open).toBe(false);
  });

  it("closes an injected database when config parsing fails", () => {
    const db = openDatabase(":memory:");

    expect(() => buildApp({
      env: { PORT: "invalid" },
      db,
      repository: repositoryFor(),
    })).toThrow("Invalid server configuration");
    expect(db.open).toBe(false);
  });

  it("closes an injected database when repository initialization fails", () => {
    const db = openDatabase(":memory:");
    db.pragma("user_version = 99");

    expect(() => buildApp({ env: {}, db })).toThrow(
      "Receipt database schema is incompatible",
    );
    expect(db.open).toBe(false);
  });
});
