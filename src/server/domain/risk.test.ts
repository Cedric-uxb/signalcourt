import { describe, expect, it } from "vitest";

import { buildRiskPlan, type RiskProfile } from "./risk.js";

describe("buildRiskPlan", () => {
  it("builds a long plan from deterministic ATR multiples", () => {
    expect(
      buildRiskPlan({
        verdict: "LONG",
        price: 100,
        atr: 5,
        riskLevel: "balanced",
      }),
    ).toEqual({
      entry: 100,
      stop: 90,
      target: 115,
      practiceSizeUsd: 100,
    });
  });

  it("builds a short plan from deterministic ATR multiples", () => {
    expect(
      buildRiskPlan({
        verdict: "SHORT",
        price: 100,
        atr: 5,
        riskLevel: "balanced",
      }),
    ).toEqual({
      entry: 100,
      stop: 110,
      target: 85,
      practiceSizeUsd: 100,
    });
  });

  it.each<[RiskProfile, number]>([
    ["conservative", 50],
    ["balanced", 100],
    ["aggressive", 200],
  ])("uses the %s practice size", (riskLevel, practiceSizeUsd) => {
    expect(
      buildRiskPlan({ verdict: "LONG", price: 100, atr: 5, riskLevel }),
    ).toMatchObject({ practiceSizeUsd });
  });

  it("rounds receipt prices to eight decimal places", () => {
    expect(
      buildRiskPlan({
        verdict: "LONG",
        price: 100.123456789,
        atr: 0.111111119,
        riskLevel: "balanced",
      }),
    ).toEqual({
      entry: 100.12345679,
      stop: 99.90123455,
      target: 100.45679015,
      practiceSizeUsd: 100,
    });
  });

  it("rejects positive risk values that become zero after rounding", () => {
    expect(
      buildRiskPlan({
        verdict: "LONG",
        price: 5e-9,
        atr: 1e-9,
        riskLevel: "balanced",
      }),
    ).toBeNull();
  });

  it.each(["LONG", "SHORT"] as const)(
    "rejects a %s plan whose direction collapses after rounding",
    (verdict) => {
      expect(
        buildRiskPlan({
          verdict,
          price: 100,
          atr: 1e-9,
          riskLevel: "balanced",
        }),
      ).toBeNull();
    },
  );

  it.each([
    { verdict: "NO_TRADE" as const, price: 100, atr: 5 },
    { verdict: "LONG" as const, price: undefined, atr: 5 },
    { verdict: "LONG" as const, price: 100, atr: null },
    { verdict: "LONG" as const, price: Number.NaN, atr: 5 },
    { verdict: "LONG" as const, price: 100, atr: Number.POSITIVE_INFINITY },
    { verdict: "LONG" as const, price: 0, atr: 5 },
    { verdict: "LONG" as const, price: 100, atr: -1 },
    { verdict: "LONG" as const, price: 10, atr: 5 },
    { verdict: "SHORT" as const, price: 10, atr: 4 },
  ])("returns null for invalid or incomplete risk input %#", (input) => {
    expect(buildRiskPlan({ ...input, riskLevel: "balanced" })).toBeNull();
  });
});
