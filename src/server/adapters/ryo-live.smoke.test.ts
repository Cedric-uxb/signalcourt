import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadLocalEnv } from "../config.js";
import { createRyoClient } from "./ryo-client.js";

const enabled = process.env.RUN_RYO_SMOKE === "1";

const liveAnalyzeTokenSchema = z.object({
  tool: z.literal("analyze_token"),
  status: z.enum(["ok", "partial"]),
  dataMode: z.literal("live"),
  asOf: z.iso.datetime({ offset: true }),
  request: z.object({ symbol: z.literal("SOL") }).passthrough(),
  data: z.object({
    market: z.object({ price_usd: z.number().positive() }).passthrough(),
    technicals: z.object({ atr_14: z.number().positive() }).passthrough(),
  }).passthrough(),
  summary: z.string().trim().min(1),
  availability: z.object({
    market: z.union([z.literal(true), z.literal("available")]),
    technicals: z.union([z.literal(true), z.literal("available")]),
  }).passthrough(),
  warnings: z.array(z.string()),
});

function requireEnvironment(name: "RYO_MCP_URL" | "RYO_MCP_KEY"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `RYO live smoke requires ${name}. Configure it in .env or export it before running the smoke test.`,
    );
  }
  return value;
}

describe.skipIf(!enabled)("RYO live smoke", () => {
  it("discovers the catalog and calls analyze_token with live-compatible evidence", async () => {
    loadLocalEnv();
    const baseUrl = requireEnvironment("RYO_MCP_URL");
    const apiKey = requireEnvironment("RYO_MCP_KEY");
    const client = createRyoClient({ baseUrl, apiKey });

    const catalog = await client.catalog();
    expect(catalog.tools.some(({ name }) => name === "analyze_token")).toBe(true);

    const result = await client.call("analyze_token", { symbol: "SOL" });
    expect(liveAnalyzeTokenSchema.safeParse(result).success).toBe(true);
  });
});
