import type { Claim, Receipt } from "../../shared/contracts.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import {
  buildRiskPlan,
  type RiskPlan,
  type RiskProfile,
  type Verdict,
} from "./risk.js";

export type DecisionInput = Readonly<{
  claimStatuses: readonly Claim["status"][];
  marketEvidenceUsable: boolean;
  missingCitations: readonly string[];
  proposedVerdict: Verdict;
  price: number | null;
  atr: number | null;
  riskLevel: RiskProfile;
  bullConfidence: number;
  bearConfidence: number;
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

function expectedVerdict(
  bullConfidence: number,
  bearConfidence: number,
): Verdict {
  if (bullConfidence > bearConfidence) return "LONG";
  if (bearConfidence > bullConfidence) return "SHORT";
  return "NO_TRADE";
}

function assertVerdictMatchesConfidence(input: DecisionInput): void {
  if (
    input.proposedVerdict !==
    expectedVerdict(input.bullConfidence, input.bearConfidence)
  ) {
    throw new RangeError("proposedVerdict must match bull and bear confidence");
  }
}

function collectReasonCodes(
  input: DecisionInput,
  riskPlan: RiskPlan | null,
): ReasonCode[] {
  const reasonCodes: ReasonCode[] = [];

  if (
    input.claimStatuses.includes("unsupported") ||
    !input.claimStatuses.includes("verified")
  ) {
    reasonCodes.push("CLAIM_UNSUPPORTED");
  }
  if (input.claimStatuses.includes("disputed")) {
    reasonCodes.push("CLAIM_DISPUTED");
  }
  if (!input.marketEvidenceUsable) {
    reasonCodes.push("MARKET_DATA_UNAVAILABLE");
  }
  if (input.missingCitations.length > 0) {
    reasonCodes.push("CITATION_INVALID");
  }
  if (input.proposedVerdict !== "NO_TRADE" && riskPlan === null) {
    reasonCodes.push("RISK_INPUT_INCOMPLETE");
  }

  return reasonCodes;
}

export function decide(input: DecisionInput): Decision {
  assertConfidence(input.bullConfidence, "bullConfidence");
  assertConfidence(input.bearConfidence, "bearConfidence");
  assertVerdictMatchesConfidence(input);

  const riskPlan = buildRiskPlan({
    verdict: input.proposedVerdict,
    price: input.price,
    atr: input.atr,
    riskLevel: input.riskLevel,
  });
  const reasonCodes = collectReasonCodes(input, riskPlan);

  if (
    reasonCodes.length > 0 ||
    input.proposedVerdict === "NO_TRADE" ||
    riskPlan === null
  ) {
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
    riskPlan,
  };
}
