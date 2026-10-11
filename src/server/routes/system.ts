import type { FastifyInstance } from "fastify";

import type { ServerConfig, ServerMode } from "../config.js";

export function registerSystemRoute(
  app: FastifyInstance,
  mode: ServerMode,
  config: ServerConfig,
): void {
  app.get("/api/system", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const live = mode === "live";
    return {
      mode,
      capabilities: {
        ryo: live && config.capabilities.ryo,
        news: live && config.capabilities.news,
        model: live && config.capabilities.model,
      },
      demoAvailable: true,
      publisherRegistryConfigured: config.publisherRegistryConfigured,
    };
  });
}
