import { describe, expect, it } from "vitest";

import { decide, type DecisionInput } from "./decision.js";

const base: DecisionInput = {
  claimStatuses: ["verified"],
  marketEvidenceUsable: true,
  missingCitations: [],
  proposedVerdict: "LONG",
  price: 100,
  atr: 5,
  riskLevel: "balanced",
  bullConfidence: 0.8,
  bearConfidence: 0.3,
};

describe("decide", () => {
  it("blocks when there is no verified claim", () => {
    expect(decide({ ...base, claimStatuses: [] })).toEqual({
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes: ["CLAIM_UNSUPPORTED"],
      riskPlan: null,
    });
  });

  it("blocks when any claim is unsupported", () => {
    expect(
      decide({
        ...base,
        claimStatuses: ["verified", "unsupported"],
      }),
    ).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["CLAIM_UNSUPPORTED"],
      riskPlan: null,
    });
  });

  it("blocks when any claim is disputed", () => {
    expect(
      decide({ ...base, claimStatuses: ["verified", "disputed"] }),
    ).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["CLAIM_DISPUTED"],
      riskPlan: null,
    });
  });

  it("blocks when market data is unusable", () => {
    expect(decide({ ...base, marketEvidenceUsable: false })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["MARKET_DATA_UNAVAILABLE"],
      riskPlan: null,
    });
  });

  it("blocks when citations are missing", () => {
    expect(
      decide({ ...base, missingCitations: ["evidence-missing"] }),
    ).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["CITATION_INVALID"],
      riskPlan: null,
    });
  });

  it("blocks a trade when risk inputs are incomplete", () => {
    expect(decide({ ...base, atr: null })).toMatchObject({
      verdict: "NO_TRADE",
      reasonCodes: ["RISK_INPUT_INCOMPLETE"],
      riskPlan: null,
    });
  });

  it("emits every determinable gate failure in a fixed order", () => {
    expect(
      decide({
        ...base,
        claimStatuses: ["unsupported", "disputed"],
        marketEvidenceUsable: false,
        missingCitations: ["evidence-missing"],
        atr: null,
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

  it("builds risk internally for a fully supported long decision", () => {
    expect(decide(base)).toEqual({
      verdict: "LONG",
      confidence: 0.8,
      reasonCodes: [],
      riskPlan: {
        entry: 100,
        stop: 90,
        target: 115,
        practiceSizeUsd: 100,
      },
    });
  });

  it("builds risk internally for a fully supported short decision", () => {
    expect(
      decide({
        ...base,
        proposedVerdict: "SHORT",
        bullConfidence: 0.2,
        bearConfidence: 0.7,
      }),
    ).toEqual({
      verdict: "SHORT",
      confidence: 0.7,
      reasonCodes: [],
      riskPlan: {
        entry: 100,
        stop: 110,
        target: 85,
        practiceSizeUsd: 100,
      },
    });
  });

  it("allows a tied no-trade decision without a reason code", () => {
    expect(
      decide({
        ...base,
        proposedVerdict: "NO_TRADE",
        bullConfidence: 0.5,
        bearConfidence: 0.5,
        price: null,
        atr: null,
      }),
    ).toEqual({
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes: [],
      riskPlan: null,
    });
  });

  it("rounds successful confidence to two decimal places", () => {
    expect(decide({ ...base, bullConfidence: 0.805 })).toMatchObject({
      verdict: "LONG",
      confidence: 0.81,
    });
  });

  it("rejects a proposed verdict that contradicts confidence", () => {
    expect(() =>
      decide({
        ...base,
        bullConfidence: 0.2,
        bearConfidence: 0.8,
      }),
    ).toThrow(RangeError);
  });

  it("does not accept or use a caller-supplied risk plan", () => {
    const callWithManualRiskPlan = () =>
      decide({
        ...base,
        price: 200,
        atr: 10,
        // @ts-expect-error DecisionInput builds risk plans from raw market inputs.
        riskPlan: {
          entry: 1,
          stop: 1,
          target: 1,
          practiceSizeUsd: 1,
        },
      });

    expect(callWithManualRiskPlan()).toMatchObject({
      verdict: "LONG",
      riskPlan: {
        entry: 200,
        stop: 180,
        target: 230,
        practiceSizeUsd: 100,
      },
    });
  });

  it.each([
    { field: "bullConfidence", bullConfidence: 1.1, bearConfidence: 0.3 },
    { field: "bearConfidence", bullConfidence: 0.8, bearConfidence: Number.NaN },
  ])("fails fast for invalid $field", ({ bullConfidence, bearConfidence }) => {
    expect(() => decide({ ...base, bullConfidence, bearConfidence })).toThrow(
      RangeError,
    );
  });
});
