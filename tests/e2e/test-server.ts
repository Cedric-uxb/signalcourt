import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { buildApp } from "../../src/server/app.js";

type DemoScenario = "supported" | "insufficient";

function readScenario(value: string | undefined): DemoScenario {
  if (value === "supported" || value === "insufficient") return value;
  throw new Error("E2E_DEMO_SCENARIO must be supported or insufficient");
}

function readPort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_PORT must be a valid port");
  }
  return port;
}

function readDatabasePath(value: string | undefined): string {
  const databasePath = value?.trim();
  if (!databasePath) throw new Error("E2E_DATABASE_PATH is required");
  return path.resolve(databasePath);
}

const scenario = readScenario(process.env.E2E_DEMO_SCENARIO);
const port = readPort(process.env.E2E_PORT);
const databasePath = readDatabasePath(process.env.E2E_DATABASE_PATH);
const databaseFiles = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];

await mkdir(path.dirname(databasePath), { recursive: true });
await Promise.all(databaseFiles.map((file) => rm(file, { force: true })));

const app = buildApp({
  mode: "demo",
  demoScenario: scenario,
  databasePath,
  env: {},
});

let shuttingDown = false;
async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await Promise.all(databaseFiles.map((file) => rm(file, { force: true })));
  process.exit(exitCode);
}

process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  await app.close();
  await Promise.all(databaseFiles.map((file) => rm(file, { force: true })));
  throw error;
}
