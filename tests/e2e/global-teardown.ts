import { rm } from "node:fs/promises";
import path from "node:path";

export default async function globalTeardown() {
  await rm(path.resolve("test-results/e2e-data"), {
    force: true,
    recursive: true,
  });
}
