import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({
    ok: true,
    service: "signalcourt",
    version: "0.1.0"
  }));

  return app;
}
