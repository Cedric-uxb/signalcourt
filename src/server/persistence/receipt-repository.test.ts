import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    replay: {
      identical: true,
      evidenceHash: "a".repeat(64),
      receiptHash: "b".repeat(64),
    },
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

function createLegacyReceiptTable(
  db: Database.Database,
  options: { noOpTriggers?: boolean } = {},
): void {
  db.exec(`
    CREATE TABLE receipts (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);

  if (options.noOpTriggers) {
    db.exec(`
      CREATE TRIGGER receipts_prevent_update
      BEFORE UPDATE ON receipts
      BEGIN
        SELECT 1;
      END;
      CREATE TRIGGER receipts_prevent_delete
      BEFORE DELETE ON receipts
      BEGIN
        SELECT 1;
      END;
    `);
  }
}

function receiptTableSql(db: Database.Database): string {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'receipts'")
    .pluck()
    .get() as string;
}

function receiptTriggerSql(db: Database.Database): Array<{ name: string; sql: string }> {
  return db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'receipts' ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string }>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("opens an in-memory database with required pragmas enabled", () => {
    const db = openDatabase(" :memory: ");

    try {
      expect(db.prepare("PRAGMA foreign_keys").pluck().get()).toBe(1);
      expect(db.prepare("PRAGMA recursive_triggers").pluck().get()).toBe(1);
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
  it("sets and verifies the schema version and recursive triggers", () => {
    const db = new Database(":memory:");
    db.pragma("recursive_triggers = OFF");

    try {
      createReceiptRepository(db);

      expect(db.pragma("user_version", { simple: true })).toBe(1);
      expect(db.pragma("recursive_triggers", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

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

  it.each(["INSERT OR REPLACE", "REPLACE"])(
    "blocks direct %s statements without changing the original receipt",
    (operation) => {
      const db = new Database(":memory:");
      const repository = createReceiptRepository(db);
      const original = receiptFixture();
      const replacement = receiptFixture({
        createdAt: "2026-10-11T13:00:00.000Z",
        confidence: 0.5,
      });
      const replaceStatement = db.prepare(
        `${operation} INTO receipts (id, created_at, payload) VALUES (?, ?, ?)`,
      );

      try {
        repository.insert(original);

        expect(() =>
          replaceStatement.run(
            replacement.id,
            replacement.createdAt,
            canonicalJson(replacement),
          ),
        ).toThrow("Receipts are append-only");
        expect(repository.findById(original.id)).toEqual(original);
      } finally {
        db.close();
      }
    },
  );

  it("replaces same-name no-op triggers with append-only triggers", () => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const receipt = receiptFixture();
    repository.insert(receipt);
    db.exec(`
      DROP TRIGGER receipts_prevent_update;
      DROP TRIGGER receipts_prevent_delete;
      CREATE TRIGGER receipts_prevent_update
      BEFORE UPDATE ON receipts
      BEGIN
        SELECT 1;
      END;
      CREATE TRIGGER receipts_prevent_delete
      BEFORE DELETE ON receipts
      BEGIN
        SELECT 1;
      END;
    `);

    try {
      const reinitializedRepository = createReceiptRepository(db);

      expect(() =>
        db.exec("UPDATE receipts SET created_at = 'changed' WHERE id = 'receipt-1'"),
      ).toThrow("Receipts are append-only");
      expect(() =>
        db.exec("DELETE FROM receipts WHERE id = 'receipt-1'"),
      ).toThrow("Receipts are append-only");
      expect(reinitializedRepository.findById(receipt.id)).toEqual(receipt);
    } finally {
      db.close();
    }
  });

  it("migrates an empty version-zero legacy table to the current schema", () => {
    const db = new Database(":memory:");
    createLegacyReceiptTable(db, { noOpTriggers: true });
    const receipt = receiptFixture();

    try {
      const repository = createReceiptRepository(db);
      repository.insert(receipt);

      expect(db.pragma("user_version", { simple: true })).toBe(1);
      expect(repository.findById(receipt.id)).toEqual(receipt);
      expect(() =>
        db.exec("UPDATE receipts SET created_at = 'changed' WHERE id = 'receipt-1'"),
      ).toThrow("Receipts are append-only");
      expect(() =>
        db.exec("DELETE FROM receipts WHERE id = 'receipt-1'"),
      ).toThrow("Receipts are append-only");
      expect(() =>
        db
          .prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)")
          .run("different-id", receipt.createdAt, canonicalJson(receipt)),
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)")
          .run("invalid-json", receipt.createdAt, "not-json"),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("rolls back the empty-table migration when rebuilding fails", () => {
    const db = new Database(":memory:");
    createLegacyReceiptTable(db, { noOpTriggers: true });
    const legacySql = receiptTableSql(db);
    const legacyTriggerSql = receiptTriggerSql(db);
    const originalExec = db.exec.bind(db);
    const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE TABLE receipts")) {
        throw new Error("forced rebuild failure");
      }
      return originalExec(sql);
    });

    const error = (() => {
      try {
        return captureError(() => createReceiptRepository(db));
      } finally {
        execSpy.mockRestore();
      }
    })();

    try {
      expect(error.message).toBe("Failed to initialize receipt database");
      expect(error.cause).toBeUndefined();
      expect(receiptTableSql(db)).toBe(legacySql);
      expect(db.prepare("SELECT COUNT(*) FROM receipts").pluck().get()).toBe(0);
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect(receiptTriggerSql(db)).toEqual(legacyTriggerSql);
    } finally {
      db.close();
    }
  });

  it("does not migrate an empty incompatible table with a nonzero version", () => {
    const db = new Database(":memory:");
    createLegacyReceiptTable(db);
    const legacySql = receiptTableSql(db);
    db.pragma("user_version = 2");

    try {
      const error = captureError(() => createReceiptRepository(db));

      expect(error.message).toBe("Receipt database schema is incompatible");
      expect(error.cause).toBeUndefined();
      expect(receiptTableSql(db)).toBe(legacySql);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });

  it("rejects a populated legacy table without required constraints", () => {
    const db = new Database(":memory:");
    const receipt = receiptFixture();
    createLegacyReceiptTable(db);
    db.prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)").run(
      receipt.id,
      receipt.createdAt,
      canonicalJson(receipt),
    );

    try {
      const error = captureError(() => createReceiptRepository(db));

      expect(error.message).toBe("Receipt database schema is incompatible");
      expect(error.cause).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) FROM receipts").pluck().get()).toBe(1);
      expect(db.prepare("SELECT payload FROM receipts").pluck().get()).toBe(
        canonicalJson(receipt),
      );
      expect(db.pragma("user_version", { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each([
    ["id", "different-id", "2026-10-11T12:00:00.000Z"],
    ["created_at", "receipt-1", "2026-10-11T13:00:00.000Z"],
  ])("rejects a direct insert whose %s does not match its payload", (_field, id, createdAt) => {
    const db = openDatabase(":memory:");
    createReceiptRepository(db);
    const receipt = receiptFixture();

    try {
      expect(() =>
        db
          .prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)")
          .run(id, createdAt, canonicalJson(receipt)),
      ).toThrow();
      expect(db.prepare("SELECT COUNT(*) FROM receipts").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

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
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)").run(
      "corrupt-receipt",
      "2026-10-11T12:00:00.000Z",
      payload,
    );
    db.pragma("ignore_check_constraints = OFF");

    try {
      const error = captureError(() => repository.findById("corrupt-receipt"));

      expect(error.message).toBe("Receipt data is invalid");
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain("raw-payload-sentinel");
    } finally {
      db.close();
    }
  });

  it.each([
    ["id", "stored-id", "2026-10-11T12:00:00.000Z"],
    ["created_at", "receipt-1", "2026-10-11T13:00:00.000Z"],
  ])("returns a fixed error when stored %s differs from the payload", (_field, id, createdAt) => {
    const db = openDatabase(":memory:");
    const repository = createReceiptRepository(db);
    const receipt = receiptFixture();
    db.pragma("ignore_check_constraints = ON");
    db.prepare("INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)").run(
      id,
      createdAt,
      canonicalJson(receipt),
    );
    db.pragma("ignore_check_constraints = OFF");

    try {
      const error = captureError(() => repository.findById(id));

      expect(error.message).toBe("Receipt data is invalid");
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain(canonicalJson(receipt));
    } finally {
      db.close();
    }
  });
});
