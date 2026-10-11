import { describe, expect, it } from "vitest";

import type { Claim } from "../../shared/contracts.js";
import { decide, type DecisionInput } from "./decision.js";

const verifiedClaim: Claim = {
  id: "claim-verified",
  text: "The filing appears in the public register.",
  status: "verified",
  evidenceIds: ["evidence-1"],
  explanation: "An independent source confirms the filing.",
};

const riskPlan = {
  entry: 100,
  stop: 90,
  target: 115,
  practiceSizeUsd: 100,
};

const base: DecisionInput = {
  proposedVerdict: "LONG",
  bullConfidence: 0.8,
  bearConfidence: 0.3,
  claims: [verifiedClaim],
  marketDataUsable: true,
  missingCitationIds: [],
  riskPlan,
};

function claim(status: Claim["status"]): Claim {
  return {
    ...verifiedClaim,
    id: `claim-${status}`,
    status,
  };
}

describe("decide", () => {
  it("blocks when there is no verified claim", () => {
    expect(decide({ ...base, claims: [] })).toEqual({
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes: ["CLAIM_UNSUPPORTED"],
      riskPlan: null,
    });
  });

  it("blocks when any claim is unsupported", () => {
    expect(decide({ ...base, claims: [verifiedClaim, claim("unsupported")] })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["CLAIM_UNSUPPORTED"],
      riskPlan: null,
    });
  });

  it("blocks when any claim is disputed", () => {
    expect(decide({ ...base, claims: [verifiedClaim, claim("disputed")] })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["CLAIM_DISPUTED"],
      riskPlan: null,
    });
  });

  it("blocks when market data is unusable", () => {
    expect(decide({ ...base, marketDataUsable: false })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["MARKET_DATA_UNAVAILABLE"],
      riskPlan: null,
    });
  });

  it("blocks when citations are missing", () => {
    expect(decide({ ...base, missingCitationIds: ["evidence-missing"] })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["CITATION_INVALID"],
      riskPlan: null,
    });
  });

  it("blocks when the risk plan is missing", () => {
    expect(decide({ ...base, riskPlan: null })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["RISK_INPUT_INCOMPLETE"],
      riskPlan: null,
    });
  });

  it("emits gate failures in a fixed order", () => {
    expect(
      decide({
        ...base,
        claims: [claim("unsupported"), claim("disputed")],
        marketDataUsable: false,
        missingCitationIds: ["evidence-missing"],
        riskPlan: null,
      }),
    ).toEqual({
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes: [
        "CLAIM_UNSUPPORTED",
        "CLAIM_DISPUTED",
        "MARKET_DATA_UNAVAILABLE",
        "CITATION_INVALID",
        "RISK_INPUT_INCOMPLETE",
      ],
      riskPlan: null,
    });
  });

  it("allows a fully supported long decision", () => {
    expect(decide(base)).toEqual({
      verdict: "LONG",
      confidence: 0.8,
      reasonCodes: [],
      riskPlan,
    });
  });

  it("rounds successful confidence to two decimal places", () => {
    expect(decide({ ...base, bullConfidence: 0.805 })).toMatchObject({
      verdict: "LONG",
      confidence: 0.81,
    });
  });

  it("blocks a proposed no-trade verdict with the closest stable reason", () => {
    expect(decide({ ...base, proposedVerdict: "NO_TRADE" })).toEqual({
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes: ["RISK_INPUT_INCOMPLETE"],
      riskPlan: null,
    });
  });

  it.each([
    { field: "bullConfidence", bullConfidence: 1.1, bearConfidence: 0.3 },
    { field: "bearConfidence", bullConfidence: 0.8, bearConfidence: Number.NaN },
  ])("fails fast for invalid $field", ({ bullConfidence, bearConfidence }) => {
    expect(() => decide({ ...base, bullConfidence, bearConfidence })).toThrow(RangeError);
  });
});
