import type Database from "better-sqlite3";

import { receiptSchema, type Receipt } from "../../shared/contracts.js";
import { canonicalJson } from "../domain/canonical-json.js";

const INVALID_ID_MESSAGE =
  "Receipt id must be a non-empty string of at most 128 characters";
const INCOMPATIBLE_SCHEMA_MESSAGE = "Receipt database schema is incompatible";
const INITIALIZATION_ERROR_MESSAGE = "Failed to initialize receipt database";
const RECEIPT_SCHEMA_VERSION = 1;

const CREATE_RECEIPTS_TABLE_SQL = `
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
      CHECK(json_valid(payload))
      CHECK(
        json_type(payload, '$.id') IS 'text'
        AND json_extract(payload, '$.id') = id
      )
      CHECK(
        json_type(payload, '$.createdAt') IS 'text'
        AND json_extract(payload, '$.createdAt') = created_at
      )
  )
`;

const CREATE_RECEIPT_TRIGGERS_SQL = `
  CREATE TRIGGER receipts_prevent_update
  BEFORE UPDATE ON receipts
  BEGIN
    SELECT RAISE(ABORT, 'Receipts are append-only');
  END;

  CREATE TRIGGER receipts_prevent_delete
  BEFORE DELETE ON receipts
  BEGIN
    SELECT RAISE(ABORT, 'Receipts are append-only');
  END;
`;

class IncompatibleReceiptSchemaError extends Error {}

type TableColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

function normalizedReceiptId(id: unknown): string {
  if (typeof id !== "string") throw new Error(INVALID_ID_MESSAGE);

  const normalized = id.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error(INVALID_ID_MESSAGE);
  }
  return normalized;
}

function isDuplicateIdError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return (
    error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function normalizedSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, "").replace(/;$/, "");
}

function hasCompatibleReceiptSchema(db: Database.Database): boolean {
  const columns = db.prepare("PRAGMA table_info(receipts)").all() as TableColumn[];
  if (columns.length !== 3) return false;

  const [id, createdAt, payload] = columns;
  if (
    !id ||
    id.name !== "id" ||
    id.type.toUpperCase() !== "TEXT" ||
    id.notnull !== 1 ||
    id.dflt_value !== null ||
    id.pk !== 1 ||
    !createdAt ||
    createdAt.name !== "created_at" ||
    createdAt.type.toUpperCase() !== "TEXT" ||
    createdAt.notnull !== 1 ||
    createdAt.dflt_value !== null ||
    createdAt.pk !== 0 ||
    !payload ||
    payload.name !== "payload" ||
    payload.type.toUpperCase() !== "TEXT" ||
    payload.notnull !== 1 ||
    payload.dflt_value !== null ||
    payload.pk !== 0
  ) {
    return false;
  }

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'receipts'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) return false;

  return normalizedSchemaSql(row.sql) === normalizedSchemaSql(CREATE_RECEIPTS_TABLE_SQL);
}

function initializeReceiptSchema(db: Database.Database): void {
  try {
    db.pragma("recursive_triggers = ON");
    if (db.pragma("recursive_triggers", { simple: true }) !== 1) {
      throw new Error("Required database pragma is unavailable");
    }

    db.transaction(() => {
      const version = db.pragma("user_version", { simple: true });
      const tableExists = Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'receipts'",
          )
          .get(),
      );

      if (version !== 0 && version !== RECEIPT_SCHEMA_VERSION) {
        throw new IncompatibleReceiptSchemaError();
      }
      if (!tableExists) {
        if (version !== 0) throw new IncompatibleReceiptSchemaError();
        db.exec(CREATE_RECEIPTS_TABLE_SQL);
      } else if (!hasCompatibleReceiptSchema(db)) {
        const receiptCount = db
          .prepare("SELECT COUNT(*) FROM receipts")
          .pluck()
          .get();
        if (version !== 0 || receiptCount !== 0) {
          throw new IncompatibleReceiptSchemaError();
        }

        db.exec(`
          DROP TRIGGER IF EXISTS main.receipts_prevent_update;
          DROP TRIGGER IF EXISTS main.receipts_prevent_delete;
        `);
        db.exec("DROP TABLE receipts");
        db.exec(CREATE_RECEIPTS_TABLE_SQL);
      }

      db.exec(`
        DROP TRIGGER IF EXISTS main.receipts_prevent_update;
        DROP TRIGGER IF EXISTS main.receipts_prevent_delete;
      `);
      db.exec(CREATE_RECEIPT_TRIGGERS_SQL);
      db.pragma(`user_version = ${RECEIPT_SCHEMA_VERSION}`);
    })();
  } catch (error) {
    if (error instanceof IncompatibleReceiptSchemaError) {
      throw new Error(INCOMPATIBLE_SCHEMA_MESSAGE);
    }
    throw new Error(INITIALIZATION_ERROR_MESSAGE);
  }
}

export function createReceiptRepository(db: Database.Database) {
  initializeReceiptSchema(db);

  let insertStatement: Database.Statement;
  let findStatement: Database.Statement;
  try {
    insertStatement = db.prepare(
      "INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)",
    );
    findStatement = db.prepare(
      "SELECT id, created_at, payload FROM receipts WHERE id = ?",
    );
  } catch {
    throw new Error(INITIALIZATION_ERROR_MESSAGE);
  }

  return {
    insert(receipt: Receipt): void {
      const valid = receiptSchema.parse(receipt);
      const id = normalizedReceiptId(valid.id);
      if (id !== valid.id) throw new Error(INVALID_ID_MESSAGE);

      try {
        insertStatement.run(id, valid.createdAt, canonicalJson(valid));
      } catch (error) {
        if (isDuplicateIdError(error)) throw new Error("Receipt already exists");
        throw error;
      }
    },

    findById(id: string): Receipt | null {
      const normalizedId = normalizedReceiptId(id);
      const row = findStatement.get(normalizedId) as
        | { id: string; created_at: string; payload: string }
        | undefined;
      if (!row) return null;

      try {
        const receipt = receiptSchema.parse(JSON.parse(row.payload));
        if (receipt.id !== row.id || receipt.createdAt !== row.created_at) {
          throw new Error("Receipt fields do not match payload");
        }
        return receipt;
      } catch {
        throw new Error("Receipt data is invalid");
      }
    },
  };
}
