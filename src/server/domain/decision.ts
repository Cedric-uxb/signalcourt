import type { Claim, Receipt } from "../../shared/contracts.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import type { RiskPlan, Verdict } from "./risk.js";

export type DecisionInput = Readonly<{
  proposedVerdict: Verdict;
  bullConfidence: number;
  bearConfidence: number;
  claims: readonly Claim[];
  marketDataUsable: boolean;
  missingCitationIds: readonly string[];
  riskPlan: RiskPlan | null;
}>;

export type Decision = Pick<
  Receipt,
  "verdict" | "confidence" | "reasonCodes" | "riskPlan"
>;

function assertConfidence(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`);
  }
}

function collectReasonCodes(input: DecisionInput): ReasonCode[] {
  const reasonCodes: ReasonCode[] = [];
  const claimStatuses = input.claims.map((claim) => claim.status);

  if (
    claimStatuses.includes("unsupported") ||
    !claimStatuses.includes("verified")
  ) {
    reasonCodes.push("CLAIM_UNSUPPORTED");
  }
  if (claimStatuses.includes("disputed")) {
    reasonCodes.push("CLAIM_DISPUTED");
  }
  if (!input.marketDataUsable) {
    reasonCodes.push("MARKET_DATA_UNAVAILABLE");
  }
  if (input.missingCitationIds.length > 0) {
    reasonCodes.push("CITATION_INVALID");
  }
  if (input.riskPlan === null || input.proposedVerdict === "NO_TRADE") {
    reasonCodes.push("RISK_INPUT_INCOMPLETE");
  }

  return reasonCodes;
}

export function decide(input: DecisionInput): Decision {
  assertConfidence(input.bullConfidence, "bullConfidence");
  assertConfidence(input.bearConfidence, "bearConfidence");

  const reasonCodes = collectReasonCodes(input);
  if (reasonCodes.length > 0) {
    return {
      verdict: "NO_TRADE",
      confidence: 0,
      reasonCodes,
      riskPlan: null,
    };
  }

  return {
    verdict: input.proposedVerdict,
    confidence: Number(
      Math.max(input.bullConfidence, input.bearConfidence).toFixed(2),
    ),
    reasonCodes,
    riskPlan: input.riskPlan,
  };
}
