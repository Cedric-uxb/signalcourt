import { Writable } from "node:stream";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerAnalysisRoute, type AnalysisPipeline } from "./analysis.js";

const validInput = {
  articleUrl: "https://example.com/sol-news",
  token: "SOL",
  riskLevel: "balanced",
};

function routeApp(pipeline: AnalysisPipeline, logger: false | object = false) {
  const app = Fastify({ bodyLimit: 32 * 1024, logger });
  const repository = { insert: vi.fn() };
  registerAnalysisRoute(app, pipeline, repository);
  return { app, repository };
}

describe("POST /api/analyses", () => {
  it.each([
    ["missing fields", {}],
    ["invalid token", { ...validInput, token: "not/a/token" }],
    ["invalid URL", { ...validInput, articleUrl: "not-a-url" }],
  ])("rejects %s before calling the pipeline", async (_name, payload) => {
    const pipeline = { run: vi.fn() } as unknown as AnalysisPipeline;
    const { app, repository } = routeApp(pipeline);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/analyses",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "INVALID_INPUT" });
      expect(response.json<{ issues: unknown[] }>().issues.length).toBeGreaterThan(0);
      for (const issue of response.json<{ issues: Array<Record<string, unknown>> }>().issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
      }
      expect(JSON.stringify(response.json())).not.toContain("not/a/token");
      expect(pipeline.run).not.toHaveBeenCalled();
      expect(repository.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns Fastify's 413 response for an oversized body", async () => {
    const pipeline = { run: vi.fn() } as unknown as AnalysisPipeline;
    const { app, repository } = routeApp(pipeline);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/analyses",
        payload: { ...validInput, token: "S".repeat(40_000) },
      });

      expect(response.statusCode).toBe(413);
      expect(pipeline.run).not.toHaveBeenCalled();
      expect(repository.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("redacts pipeline failures from both response and logs", async () => {
    const sentinel = "pipeline-secret-value";
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const pipeline = {
      run: vi.fn(async () => {
        throw new Error(sentinel);
      }),
    } as unknown as AnalysisPipeline;
    const { app } = routeApp(pipeline, { level: "warn", stream });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/analyses",
        payload: validInput,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "ANALYSIS_UNAVAILABLE" });
      expect(response.body).not.toContain(sentinel);
      expect(chunks.join("")).not.toContain(sentinel);
      expect(chunks.join("")).toContain("ANALYSIS_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });
});
