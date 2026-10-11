import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

describe("GET /api/health", () => {
  it("returns the SignalCourt service status", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/health"
    });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "signalcourt",
      version: "0.1.0"
    });
  });
});
