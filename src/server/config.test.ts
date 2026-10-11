import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalEnv, readConfig } from "./config.js";

const liveEnv = {
  RYO_MCP_KEY: "  ryo-secret  ",
  TAVILY_API_KEY: "  tavily-secret  ",
  LLM_BASE_URL: "  https://llm.example.test/v1  ",
  LLM_API_KEY: "  llm-secret  ",
  LLM_MODEL: "  fixture-model  ",
  PUBLISHER_REGISTRY_JSON: JSON.stringify({
    "News.Example.": " publisher-a ",
    "wire.example": "publisher-b",
  }),
};

const temporaryDirectories: string[] = [];
const envTestKeys = ["SIGNALCOURT_ENV_LOADED", "SIGNALCOURT_ENV_PREEXISTING"];
const originalEnv = Object.fromEntries(
  envTestKeys.map((key) => [key, process.env[key]]),
);

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "signalcourt-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const key of envTestKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("readConfig", () => {
  it("uses safe demo defaults without reading unrelated environment fields", () => {
    const config = readConfig({ UNRELATED_PROCESS_FIELD: "allowed" });

    expect(config).toMatchObject({
      PORT: 8787,
      DATABASE_PATH: "./data/signalcourt.sqlite",
      RYO_MCP_URL: "https://app-ryochan.com/api/mcp",
      mode: "demo",
      liveReady: false,
      capabilities: { ryo: false, news: false, model: false },
      publisherRegistry: {},
      publisherRegistryConfigured: false,
    });
    expect(config.missing).toEqual([
      "RYO_MCP_KEY",
      "TAVILY_API_KEY",
      "LLM_BASE_URL",
      "LLM_API_KEY",
      "LLM_MODEL",
      "PUBLISHER_REGISTRY_JSON",
    ]);
  });

  it("trims complete live configuration and normalizes publisher domains", () => {
    const config = readConfig({
      ...liveEnv,
      PORT: " 9443 ",
      DATABASE_PATH: " ./tmp/receipts.sqlite ",
      RYO_MCP_URL: " https://ryo.example.test/mcp/ ",
    });

    expect(config).toMatchObject({
      PORT: 9443,
      DATABASE_PATH: "./tmp/receipts.sqlite",
      RYO_MCP_URL: "https://ryo.example.test/mcp/",
      RYO_MCP_KEY: "ryo-secret",
      TAVILY_API_KEY: "tavily-secret",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "llm-secret",
      LLM_MODEL: "fixture-model",
      mode: "live",
      liveReady: true,
      capabilities: { ryo: true, news: true, model: true },
      publisherRegistry: {
        "news.example": "publisher-a",
        "wire.example": "publisher-b",
      },
      publisherRegistryConfigured: true,
      missing: [],
    });
  });

  it("accepts registrable co.uk and com domains", () => {
    const config = readConfig({
      PUBLISHER_REGISTRY_JSON: JSON.stringify({
        "BBC.CO.UK.": "publisher-a",
        "Example.COM": "publisher-b",
      }),
    });

    expect(config.publisherRegistry).toEqual({
      "bbc.co.uk": "publisher-a",
      "example.com": "publisher-b",
    });
    expect(config.publisherRegistryConfigured).toBe(true);
  });

  it("reports partial configuration by field name without exposing values", () => {
    const sentinel = "partial-secret-value";
    const config = readConfig({
      RYO_MCP_KEY: ` ${sentinel} `,
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "   ",
      PUBLISHER_REGISTRY_JSON: JSON.stringify({
        "one.example": "same-publisher",
        "two.example": "same-publisher",
      }),
    });

    expect(config.mode).toBe("demo");
    expect(config.capabilities).toEqual({ ryo: true, news: false, model: false });
    expect(config.publisherRegistryConfigured).toBe(false);
    expect(config.missing).toEqual([
      "TAVILY_API_KEY",
      "LLM_API_KEY",
      "LLM_MODEL",
      "PUBLISHER_REGISTRY_JSON",
    ]);
    expect(JSON.stringify({ capabilities: config.capabilities, missing: config.missing }))
      .not.toContain(sentinel);
  });

  it.each(["0", "65536", "1.5", "not-a-port"])(
    "rejects invalid PORT %j with a fixed error",
    (PORT) => {
      expect(() => readConfig({ PORT })).toThrow("Invalid server configuration");
    },
  );

  it.each(["1", "65535"])("accepts boundary PORT %j", (PORT) => {
    expect(readConfig({ PORT }).PORT).toBe(Number(PORT));
  });

  it("rejects an explicitly blank database path", () => {
    expect(() => readConfig({ DATABASE_PATH: "   " })).toThrow(
      "Invalid server configuration",
    );
  });

  it.each([
    ["RYO_MCP_URL", "http://ryo.example.test/mcp"],
    ["RYO_MCP_URL", "https://user:pass@ryo.example.test/mcp"],
    ["RYO_MCP_URL", "https://ryo.example.test/mcp?secret=value"],
    ["RYO_MCP_URL", "https://ryo.example.test/mcp?"],
    ["RYO_MCP_URL", "https://ryo.example.test/mcp#secret"],
    ["RYO_MCP_URL", "https://ryo.example.test/mcp#"],
    ["LLM_BASE_URL", "http://llm.example.test/v1"],
    ["LLM_BASE_URL", "https://user:pass@llm.example.test/v1"],
    ["LLM_BASE_URL", "https://llm.example.test/v1?secret=value"],
    ["LLM_BASE_URL", "https://llm.example.test/v1?"],
    ["LLM_BASE_URL", "https://llm.example.test/v1#secret"],
    ["LLM_BASE_URL", "https://llm.example.test/v1#"],
  ])("rejects unsafe %s", (field, value) => {
    const sentinel = "secret=value";
    const error = (() => {
      try {
        readConfig({ [field]: value });
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected config parsing to fail");
    })();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid server configuration");
    expect((error as Error).message).not.toContain(sentinel);
    expect((error as Error).cause).toBeUndefined();
  });

  it.each(["", "   "])("treats blank optional values as missing", (blank) => {
    const config = readConfig({
      RYO_MCP_KEY: blank,
      TAVILY_API_KEY: blank,
      LLM_BASE_URL: blank,
      LLM_API_KEY: blank,
      LLM_MODEL: blank,
      PUBLISHER_REGISTRY_JSON: blank,
    });

    expect(config.mode).toBe("demo");
    expect(config.publisherRegistry).toEqual({});
    expect(config.missing).toHaveLength(6);
  });

  it.each([
    "[]",
    "null",
    JSON.stringify({ "example.com": "" }),
    JSON.stringify({ "": "publisher" }),
    JSON.stringify({ constructor: "publisher" }),
    JSON.stringify({ prototype: "publisher" }),
    '{"__proto__":"publisher"}',
    JSON.stringify({ "Example.com": "one", "example.com.": "two" }),
    JSON.stringify({ "not a domain": "publisher" }),
    JSON.stringify({ "https://news.example/path": "publisher" }),
    JSON.stringify({ "sub.news.example": "publisher" }),
    JSON.stringify({ "127.0.0.1": "publisher" }),
    JSON.stringify({ "news.example:443": "publisher" }),
    JSON.stringify({ "user@news.example": "publisher" }),
    JSON.stringify({ "mañana.com": "one", "xn--maana-pta.com": "two" }),
  ])("rejects an invalid publisher registry without exposing it: %s", (registry) => {
    const error = (() => {
      try {
        readConfig({ PUBLISHER_REGISTRY_JSON: registry });
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected config parsing to fail");
    })();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid server configuration");
    expect((error as Error).message).not.toContain(registry);
  });
});

describe("loadLocalEnv", () => {
  it("loads a local env file without overwriting existing process values", () => {
    const path = join(temporaryDirectory(), ".env");
    writeFileSync(path, [
      "SIGNALCOURT_ENV_LOADED=from-file",
      "SIGNALCOURT_ENV_PREEXISTING=from-file",
      "",
    ].join("\n"));
    process.env.SIGNALCOURT_ENV_PREEXISTING = "from-process";

    loadLocalEnv(path);

    expect(process.env.SIGNALCOURT_ENV_LOADED).toBe("from-file");
    expect(process.env.SIGNALCOURT_ENV_PREEXISTING).toBe("from-process");
  });

  it("ignores a missing local env file", () => {
    expect(() => loadLocalEnv(join(temporaryDirectory(), "missing.env"))).not.toThrow();
  });

  it("rejects invalid env syntax with a fixed error", () => {
    const path = join(temporaryDirectory(), "invalid.env");
    const sentinel = "raw-env-file-sentinel";
    writeFileSync(path, `NOT VALID ${sentinel}\n`);

    const error = (() => {
      try {
        loadLocalEnv(path);
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected local env loading to fail");
    })();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to load local environment");
    expect((error as Error).message).not.toContain(sentinel);
    expect((error as Error).cause).toBeUndefined();
  });
});
