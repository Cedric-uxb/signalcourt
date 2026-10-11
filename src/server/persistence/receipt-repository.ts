import type Database from "better-sqlite3";

import { receiptSchema, type Receipt } from "../../shared/contracts.js";
import { canonicalJson } from "../domain/canonical-json.js";

const INVALID_ID_MESSAGE =
  "Receipt id must be a non-empty string of at most 128 characters";

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

export function createReceiptRepository(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload))
    );

    CREATE TRIGGER IF NOT EXISTS receipts_prevent_update
    BEFORE UPDATE ON receipts
    BEGIN
      SELECT RAISE(ABORT, 'Receipts are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS receipts_prevent_delete
    BEFORE DELETE ON receipts
    BEGIN
      SELECT RAISE(ABORT, 'Receipts are append-only');
    END;
  `);

  const insertStatement = db.prepare(
    "INSERT INTO receipts (id, created_at, payload) VALUES (?, ?, ?)",
  );
  const findStatement = db.prepare("SELECT payload FROM receipts WHERE id = ?");

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
      const row = findStatement.get(normalizedId) as { payload: string } | undefined;
      if (!row) return null;

      try {
        return receiptSchema.parse(JSON.parse(row.payload));
      } catch {
        throw new Error("Receipt data is invalid");
      }
    },
  };
}
