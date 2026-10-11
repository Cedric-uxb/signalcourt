import { randomUUID } from "node:crypto";

import Fastify, { type FastifyServerOptions } from "fastify";
import type Database from "better-sqlite3";

import type { Receipt } from "../shared/contracts.js";
import { fetchArticle } from "./adapters/article-fetcher.js";
import { createLlmClient } from "./adapters/llm-client.js";
import { createRyoClient } from "./adapters/ryo-client.js";
import { searchNews } from "./adapters/tavily-client.js";
import { createDemoDependencies } from "./analysis/demo-fixture.js";
import {
  createAnalysisPipeline,
  type AnalysisDependencies,
} from "./analysis/pipeline.js";
import {
  readConfig,
  type ServerConfig,
  type ServerMode,
} from "./config.js";
import { openDatabase } from "./persistence/database.js";
import { createReceiptRepository } from "./persistence/receipt-repository.js";
import {
  registerAnalysisRoute,
  type AnalysisPipeline,
} from "./routes/analysis.js";
import { registerReceiptRoutes } from "./routes/receipts.js";
import { registerSystemRoute } from "./routes/system.js";

type ReceiptRepository = {
  insert: (receipt: Receipt) => void;
  findById: (id: string) => Receipt | null;
};

export type AppOptions = {
  mode?: ServerMode;
  databasePath?: string;
  demoScenario?: "supported" | "insufficient";
  env?: NodeJS.ProcessEnv;
  logger?: FastifyServerOptions["logger"];
  config?: ServerConfig;
  dependencies?: AnalysisDependencies;
  pipeline?: AnalysisPipeline;
  repository?: ReceiptRepository;
  db?: Database.Database;
  idGenerator?: () => string;
};

function createLiveDependencies(config: ServerConfig): AnalysisDependencies {
  const {
    RYO_MCP_KEY,
    TAVILY_API_KEY,
    LLM_BASE_URL,
    LLM_API_KEY,
    LLM_MODEL,
  } = config;
  if (
    !RYO_MCP_KEY ||
    !TAVILY_API_KEY ||
    !LLM_BASE_URL ||
    !LLM_API_KEY ||
    !LLM_MODEL
  ) {
    throw new Error("Live dependencies are not configured");
  }

  return {
    articleFetcher: fetchArticle,
    newsSearcher: (query) => searchNews(query, TAVILY_API_KEY),
    ryo: createRyoClient({ baseUrl: config.RYO_MCP_URL, apiKey: RYO_MCP_KEY }),
    llm: createLlmClient({
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
    }),
    now: () => new Date(),
    evidenceMode: "live",
    publisherRegistry: config.publisherRegistry,
  };
}

export function buildApp(options: AppOptions = {}) {
  let db = options.db;
  let databaseClosed = false;

  const closeDatabase = () => {
    if (!db || databaseClosed) return;
    databaseClosed = true;
    if (db.open) db.close();
  };

  try {
    const config = options.config ?? readConfig(options.env ?? process.env);
    const mode = options.mode ?? config.mode;
    if (mode === "live" && !config.liveReady) {
      throw new Error("Live dependencies are not configured");
    }

    const app = Fastify({
      bodyLimit: 32 * 1024,
      logger: options.logger ?? false,
      routerOptions: { maxParamLength: 256 },
    });
    let repository = options.repository;
    if (!repository) {
      db ??= openDatabase(options.databasePath ?? config.DATABASE_PATH);
      repository = createReceiptRepository(db);
    }

    let pipeline = options.pipeline;
    if (!pipeline) {
      const dependencies = options.dependencies ?? (mode === "demo"
        ? {
            ...createDemoDependencies(options.demoScenario ?? "supported"),
            id: options.idGenerator ?? randomUUID,
          }
        : createLiveDependencies(config));
      pipeline = createAnalysisPipeline(dependencies);
    }

    app.get("/api/health", async () => ({
      ok: true,
      service: "signalcourt",
      version: "0.1.0",
    }));
    registerSystemRoute(app, mode, config);
    registerAnalysisRoute(app, pipeline, repository);
    registerReceiptRoutes(app, repository);
    app.addHook("onClose", async () => closeDatabase());
    return app;
  } catch (error) {
    closeDatabase();
    throw error;
  }
}
