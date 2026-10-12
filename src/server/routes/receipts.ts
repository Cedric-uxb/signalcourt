import type { FastifyInstance } from "fastify";

import type { Receipt } from "../../shared/contracts.js";
import { replayReceipt } from "../analysis/pipeline.js";

const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ReceiptReader = {
  findById: (id: string) => Receipt | null;
};

function validReceiptId(id: string): boolean {
  return RECEIPT_ID_PATTERN.test(id);
}

export function registerReceiptRoutes(
  app: FastifyInstance,
  repository: ReceiptReader,
): void {
  app.get<{ Params: { id: string } }>("/api/receipts/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validReceiptId(request.params.id)) {
      return reply.code(400).send({ error: "INVALID_RECEIPT_ID" });
    }

    try {
      const receipt = repository.findById(request.params.id);
      return receipt ?? reply.code(404).send({ error: "RECEIPT_NOT_FOUND" });
    } catch {
      return reply.code(503).send({ error: "RECEIPT_UNAVAILABLE" });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/receipts/:id/replay",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!validReceiptId(request.params.id)) {
        return reply.code(400).send({ error: "INVALID_RECEIPT_ID" });
      }

      try {
        const receipt = repository.findById(request.params.id);
        if (!receipt) {
          return reply.code(404).send({ error: "RECEIPT_NOT_FOUND" });
        }
        const replay = replayReceipt(receipt);
        return { id: receipt.id, ...replay };
      } catch {
        return reply.code(503).send({ error: "RECEIPT_UNAVAILABLE" });
      }
    },
  );
}
