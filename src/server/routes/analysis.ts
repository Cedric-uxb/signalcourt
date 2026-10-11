import type { FastifyInstance } from "fastify";

import {
  analysisRequestSchema,
  type Receipt,
} from "../../shared/contracts.js";

export type AnalysisPipeline = {
  run: (input: unknown) => Promise<Receipt>;
};

export type ReceiptWriter = {
  insert: (receipt: Receipt) => void;
};

export function registerAnalysisRoute(
  app: FastifyInstance,
  pipeline: AnalysisPipeline,
  repository: ReceiptWriter,
): void {
  app.post("/api/analyses", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const parsed = analysisRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        issues: parsed.error.issues.map(({ path, code, message }) => ({
          path,
          code,
          message,
        })),
      });
    }

    try {
      const receipt = await pipeline.run(parsed.data);
      repository.insert(receipt);
      return reply.code(201).send(receipt);
    } catch {
      request.log.warn(
        { stage: "analysis", code: "ANALYSIS_UNAVAILABLE" },
        "analysis unavailable",
      );
      return reply.code(503).send({ error: "ANALYSIS_UNAVAILABLE" });
    }
  });
}
