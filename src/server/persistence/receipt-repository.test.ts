import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { receiptSchema, type Receipt } from "../../shared/contracts.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { openDatabase } from "./database.js";
import { createReceiptRepository } from "./receipt-repository.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "signalcourt-receipts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function receiptFixture(overrides: Partial<Receipt> = {}): Receipt {
  return receiptSchema.parse({
    replay: { identical: true, evidenceHash: "evidence-hash" },
    model: { promptVersion: "test", name: "fixture" },
    riskPlan: null,
    causalChain: ["Independent evidence is insufficient"],
    reasonCodes: ["INSUFFICIENT_EVIDENCE"],
    confidence: 0,
    verdict: "NO_TRADE",
    arguments: [
      {
        citations: ["evidence-1"],
        confidence: 0.7,
        thesis: "Supporting evidence exists",
        stance: "bull",
      },
      {
        citations: ["evidence-1"],
        confidence: 0.4,
        thesis: "Material uncertainty remains",
        stance: "bear",
      },
    ],
    claims: [],
    evidence: [
      {
        warnings: [],
        summary: "Market evidence is incomplete",
        payload: { z: 1, a: { y: 2, b: 3 } },
        dataMode: "live",
        status: "ok",
        observedAt: null,
        retrievedAt: "2026-10-11T12:00:00.000Z",
        source: "https://example.com/evidence",
        kind: "article",
        hash: "a".repeat(64),
        id: "evidence-1",
      },
    ],
    input: {
      riskLevel: "balanced",
      token: "BTC",
      articleUrl: "https://example.com/article",
    },
    createdAt: "2026-10-11T12:00:00.000Z",
    id: "receipt-1",
    schemaVersion: "1.0",
    ...overrides,
  });
}

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected operation to throw an Error");
  }
  throw new Error("Expected operation to throw");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("opens an in-memory database with foreign keys enabled", () => {
    const db = openDatabase(" :memory: ");

    try {
      expect(db.prepare("PRAGMA foreign_keys").pluck().get()).toBe(1);
      expect(db.name).toBe(":memory:");
    } finally {
      db.close();
    }
  });

  it("creates nested directories and a persistent database file", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "nested", "data", "receipts.sqlite");
    const db = openDatabase(`  ${databasePath}  `);

    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    db.close();

    expect(existsSync(databasePath)).toBe(true);
  });

  it.each(["", "   "])("rejects an empty database path %j", (path) => {
    expect(() => openDatabase(path)).toThrow("Database path must not be empty");
  });

  it("adds safe context when preparing the parent directory fails", () => {
    const directory = temporaryDirectory();
    const sentinel = "sensitive-parent-path";
    const parentFile = join(directory, sentinel);
    writeFileSync(parentFile, "not a directory");

    const error = captureError(() =>
      openDatabase(join(parentFile, "receipts.sqlite")),
    );

    expect(error.message).toBe("Failed to prepare database directory");
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(sentinel);
  });

  it("adds safe context when opening the database fails", () => {
    const directory = temporaryDirectory();

    const error = captureError(() => openDatabase(directory));

    expect(error.message).toBe("Failed to open database");
    expect(error.cause).toBeUndefined();
  });
});

describe("receipt repository", () => {
  it("stores and returns a valid receipt", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const receipt = receiptFixture();

    try {
      repository.insert(receipt);

      expect(repository.findById(receipt.id)).toEqual(receipt);
      expect(repository.findById("missing-receipt")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("stores the canonical receipt payload", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const receipt = receiptFixture();

    try {
      repository.insert(receipt);
      const row = db
        .prepare("SELECT payload FROM receipts WHERE id = ?")
        .get(receipt.id) as { payload: string };

      expect(row.payload).toBe(canonicalJson(receipt));
    } finally {
      db.close();
    }
  });

  it("rejects invalid receipts before executing SQL", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const invalidReceipt = { ...receiptFixture(), createdAt: "not-a-date" };
    const changesBefore = db.prepare("SELECT total_changes()").pluck().get();

    try {
      expect(() => repository.insert(invalidReceipt)).toThrow();
      expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changesBefore);
      expect(db.prepare("SELECT COUNT(*) FROM receipts").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate ids without changing the first receipt", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const first = receiptFixture();
    const duplicate = receiptFixture({
      createdAt: "2026-10-11T13:00:00.000Z",
      confidence: 0.5,
    });

    try {
      repository.insert(first);

      expect(() => repository.insert(duplicate)).toThrow("Receipt already exists");
      expect(repository.findById(first.id)).toEqual(first);
    } finally {
      db.close();
    }
  });

  it("does not retain or return shared receipt objects", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const receipt = receiptFixture();

    try {
      repository.insert(receipt);
      receipt.input.token = "ETH";

      const firstRead = repository.findById("receipt-1");
      expect(firstRead?.input.token).toBe("BTC");

      if (!firstRead) throw new Error("Expected stored receipt");
      firstRead.input.token = "SOL";

      expect(repository.findById("receipt-1")?.input.token).toBe("BTC");
    } finally {
      db.close();
    }
  });

  it.each(["UPDATE receipts SET created_at = 'changed' WHERE id = 'receipt-1'", "DELETE FROM receipts WHERE id = 'receipt-1'"])(
    "blocks direct append-only violation: %s",
    (sql) => {
      const db = openDatabase(":memory:");
      const repository = createReceiptRepository(db);
      const receipt = receiptFixture();

      try {
        repository.insert(receipt);

        expect(() => db.exec(sql)).toThrow("Receipts are append-only");
        expect(repository.findById(receipt.id)).toEqual(receipt);
      } finally {
        db.close();
      }
    },
  );

  it.each([
    ["non-string", 42],
    ["empty", ""],
    ["blank", "   "],
    ["oversize", "a".repeat(129)],
  ])("rejects an invalid lookup id: %s", (_label, id) => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);

    try {
      expect(() => repository.findById(id as string)).toThrow(
        "Receipt id must be a non-empty string of at most 128 characters",
      );
    } finally {
      db.close();
    }
  });

  it("trims a valid lookup id", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const receipt = receiptFixture();

    try {
      repository.insert(receipt);
      expect(repository.findById(`  ${receipt.id}  `)).toEqual(receipt);
    } finally {
      db.close();
    }
  });

  it.each([
    ["malformed JSON", "raw-payload-sentinel"],
    ["schema-invalid JSON", '{"secret":"raw-payload-sentinel"}'],
  ])("returns a fixed error for %s", (_label, payload) => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)").run(
      "corrupt-receipt",
      "2026-10-11T12:00:00.000Z",
      payload,
    );
    const repository = createReceiptRepository(db);

    try {
      const error = captureError(() => repository.findById("corrupt-receipt"));

      expect(error.message).toBe("Receipt data is invalid");
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain("raw-payload-sentinel");
    } finally {
      db.close();
    }
  });
});
