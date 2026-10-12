export const reasonCodes = [
  "CLAIM_UNSUPPORTED",
  "CLAIM_DISPUTED",
  "MARKET_DATA_UNAVAILABLE",
  "CITATION_INVALID",
  "RISK_INPUT_INCOMPLETE",
  "MODEL_UNAVAILABLE",
  "INSUFFICIENT_EVIDENCE",
] as const;

export type ReasonCode = (typeof reasonCodes)[number];
