const CONFIG_ERROR = "Invalid server configuration";
const DEFAULT_RYO_MCP_URL = "https://app-ryochan.com/api/mcp";
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type ServerMode = "demo" | "live";

export type ServerConfig = {
  PORT: number;
  DATABASE_PATH: string;
  RYO_MCP_URL: string;
  RYO_MCP_KEY?: string;
  TAVILY_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  publisherRegistry: Readonly<Record<string, string>>;
  publisherRegistryConfigured: boolean;
  capabilities: Readonly<{ ryo: boolean; news: boolean; model: boolean }>;
  missing: string[];
  liveReady: boolean;
  mode: ServerMode;
};

function invalidConfig(): never {
  throw new Error(CONFIG_ERROR);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPort(value: string | undefined): number {
  if (value === undefined) return 8787;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) invalidConfig();
  return port;
}

function readDatabasePath(value: string | undefined): string {
  if (value === undefined) return "./data/signalcourt.sqlite";
  const path = value.trim();
  if (!path) invalidConfig();
  return path;
}

function readHttpsUrl(value: string, optional: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed && optional) return undefined;
  if (!trimmed) invalidConfig();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalidConfig();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalidConfig();
  }
  return trimmed;
}

function readPublisherRegistry(value: string | undefined): Readonly<Record<string, string>> {
  const trimmed = value?.trim();
  if (!trimmed) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed) as unknown;
  } catch {
    return invalidConfig();
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    invalidConfig();
  }

  const normalized: Record<string, string> = {};
  for (const [rawDomain, rawPublisherId] of Object.entries(raw)) {
    const domain = rawDomain.trim().toLowerCase().replace(/\.+$/, "");
    if (
      !domain ||
      DANGEROUS_KEYS.has(domain) ||
      Object.prototype.hasOwnProperty.call(normalized, domain) ||
      typeof rawPublisherId !== "string"
    ) {
      invalidConfig();
    }
    const publisherId = rawPublisherId.trim();
    if (!publisherId) invalidConfig();
    normalized[domain] = publisherId;
  }
  return normalized;
}

export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const PORT = readPort(env.PORT);
  const DATABASE_PATH = readDatabasePath(env.DATABASE_PATH);
  const RYO_MCP_URL = readHttpsUrl(
    env.RYO_MCP_URL ?? DEFAULT_RYO_MCP_URL,
    false,
  );
  if (!RYO_MCP_URL) invalidConfig();

  const RYO_MCP_KEY = optionalTrimmed(env.RYO_MCP_KEY);
  const TAVILY_API_KEY = optionalTrimmed(env.TAVILY_API_KEY);
  const LLM_BASE_URL = env.LLM_BASE_URL === undefined
    ? undefined
    : readHttpsUrl(env.LLM_BASE_URL, true);
  const LLM_API_KEY = optionalTrimmed(env.LLM_API_KEY);
  const LLM_MODEL = optionalTrimmed(env.LLM_MODEL);
  const publisherRegistry = readPublisherRegistry(env.PUBLISHER_REGISTRY_JSON);
  const publisherRegistryConfigured =
    new Set(Object.values(publisherRegistry)).size >= 2;
  const capabilities = {
    ryo: Boolean(RYO_MCP_KEY),
    news: Boolean(TAVILY_API_KEY),
    model: Boolean(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL),
  };

  const missing = [
    !RYO_MCP_KEY ? "RYO_MCP_KEY" : null,
    !TAVILY_API_KEY ? "TAVILY_API_KEY" : null,
    !LLM_BASE_URL ? "LLM_BASE_URL" : null,
    !LLM_API_KEY ? "LLM_API_KEY" : null,
    !LLM_MODEL ? "LLM_MODEL" : null,
    !publisherRegistryConfigured ? "PUBLISHER_REGISTRY_JSON" : null,
  ].filter((name): name is string => name !== null);
  const liveReady =
    capabilities.ryo &&
    capabilities.news &&
    capabilities.model &&
    publisherRegistryConfigured;

  return {
    PORT,
    DATABASE_PATH,
    RYO_MCP_URL,
    RYO_MCP_KEY,
    TAVILY_API_KEY,
    LLM_BASE_URL,
    LLM_API_KEY,
    LLM_MODEL,
    publisherRegistry,
    publisherRegistryConfigured,
    capabilities,
    missing,
    liveReady,
    mode: liveReady ? "live" : "demo",
  };
}
