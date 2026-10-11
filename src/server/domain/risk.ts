import type { AnalysisRequest, Receipt } from "../../shared/contracts.js";

export type RiskProfile = AnalysisRequest["riskLevel"];
export type Verdict = Receipt["verdict"];
export type RiskPlan = NonNullable<Receipt["riskPlan"]>;

export type RiskInput = Readonly<{
  verdict: Verdict;
  price?: number | null;
  atr?: number | null;
  riskLevel: RiskProfile;
}>;

const practiceSizeUsdByRiskProfile: Record<RiskProfile, number> = {
  conservative: 50,
  balanced: 100,
  aggressive: 200,
};

function roundReceiptNumber(value: number): number {
  return Number(value.toFixed(8));
}

export function buildRiskPlan(input: RiskInput): RiskPlan | null {
  const { verdict, price, atr, riskLevel } = input;
  if (
    verdict === "NO_TRADE" ||
    price === null ||
    price === undefined ||
    atr === null ||
    atr === undefined ||
    !Number.isFinite(price) ||
    !Number.isFinite(atr) ||
    price <= 0 ||
    atr <= 0
  ) {
    return null;
  }

  const direction = verdict === "LONG" ? 1 : -1;
  const stop = price - direction * 2 * atr;
  const target = price + direction * 3 * atr;
  if (
    !Number.isFinite(stop) ||
    !Number.isFinite(target) ||
    stop <= 0 ||
    target <= 0
  ) {
    return null;
  }

  return {
    entry: roundReceiptNumber(price),
    stop: roundReceiptNumber(stop),
    target: roundReceiptNumber(target),
    practiceSizeUsd: practiceSizeUsdByRiskProfile[riskLevel],
  };
}
