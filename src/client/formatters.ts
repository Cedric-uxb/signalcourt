import type { Claim, Evidence } from "../shared/contracts";

const reasonLabels: Readonly<Record<string, string>> = {
  CLAIM_UNSUPPORTED: "Claim unsupported",
  CLAIM_DISPUTED: "Claim disputed",
  MARKET_DATA_UNAVAILABLE: "Market data unavailable",
  CITATION_INVALID: "Citation invalid",
  RISK_INPUT_INCOMPLETE: "Risk input incomplete",
  MODEL_UNAVAILABLE: "Model unavailable",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
};

const claimLabels: Readonly<Record<Claim["status"], string>> = {
  verified: "Verified",
  disputed: "Disputed",
  unsupported: "Unsupported",
  unavailable: "Unavailable",
};

const evidenceStatusLabels: Readonly<Record<Evidence["status"], string>> = {
  ok: "Available",
  partial: "Partial",
  unavailable: "Unavailable",
};

export function reasonLabel(code: string): string {
  return reasonLabels[code] ?? code.toLowerCase().replaceAll("_", " ");
}

export function claimStatusLabel(status: Claim["status"]): string {
  return claimLabels[status];
}

export function evidenceStatusLabel(status: Evidence["status"]): string {
  return evidenceStatusLabels[status];
}

export function dataModeLabel(mode: Evidence["dataMode"]): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function causalStepLabel(step: string): string {
  const claim = /^claim:(.+):(verified|disputed|unsupported|unavailable):([a-f0-9]{64})$/
    .exec(step);
  if (claim) {
    const id = claim[1] ?? "unknown";
    const status = claim[2] ?? "unknown";
    const hash = claim[3] ?? "";
    return `Claim ${id} was ${status} (audit ${hash.slice(0, 8)}).`;
  }

  const debate = /^arguments:([a-f0-9]{64})$/.exec(step);
  if (debate) {
    return `Bull and bear cases were bound to the same evidence pack (audit ${(debate[1] ?? "").slice(0, 8)}).`;
  }

  return step;
}
