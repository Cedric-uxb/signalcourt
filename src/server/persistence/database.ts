import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
  const normalizedPath = typeof path === "string" ? path.trim() : "";
  if (!normalizedPath) {
    throw new Error("Database path must not be empty");
  }

  if (normalizedPath !== ":memory:") {
    try {
      mkdirSync(dirname(normalizedPath), { recursive: true });
    } catch {
      throw new Error("Failed to prepare database directory");
    }
  }

  let db: Database.Database;
  try {
    db = new Database(normalizedPath);
  } catch {
    throw new Error("Failed to open database");
  }

  try {
    db.pragma("foreign_keys = ON");
    if (normalizedPath !== ":memory:") {
      db.pragma("journal_mode = WAL");
    }
    return db;
  } catch {
    db.close();
    throw new Error("Failed to initialize database");
  }
}
