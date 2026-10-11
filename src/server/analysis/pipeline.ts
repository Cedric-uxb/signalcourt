import { randomUUID } from "node:crypto";
import { getDomain } from "tldts";
import { z } from "zod";
import {
  analysisRequestSchema,
  bearArgumentSchema,
  bullArgumentSchema,
  receiptSchema,
  type Argument,
  type Claim,
  type Evidence,
  type Receipt,
} from "../../shared/contracts.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import { canonicalJson, sha256 } from "../domain/canonical-json.js";
import { validateCitations } from "../domain/citations.js";
import { decide } from "../domain/decision.js";
import { promptVersion } from "./prompts.js";

type ExtractedClaim = { id: string; text: string };
export type NewsResult = {
  title: string;
  url: string;
  excerpt: string;
};
export type VerificationNewsEvidence = NewsResult & { id: string };
export type ClaimVerification = {
  claimId: string;
  status: "verified" | "disputed" | "unsupported";
  evidenceIds: string[];
  explanation: string;
};
export type RyoResult = {
  tool: string;
  status: "ok" | "partial" | "unavailable";
  dataMode: "live" | "mixed" | "simulated" | "unknown";
  asOf: string;
  request: Record<string, unknown>;
  data: unknown;
  availability: Record<string, unknown>;
  summary: string;
  warnings: string[];
};
export type AnalysisDependencies = {
  articleFetcher: (url: string) => Promise<{ url: string; text: string }>;
  newsSearcher: (query: string) => Promise<NewsResult[]>;
  ryo: {
    call: (
      tool: string,
      arguments_: Record<string, unknown>,
    ) => Promise<RyoResult>;
  };
  llm: {
    model: string;
    extractClaims: (text: string) => Promise<ExtractedClaim[]>;
    verifyClaims: (
      claims: ExtractedClaim[],
      newsEvidence: VerificationNewsEvidence[],
    ) => Promise<ClaimVerification[]>;
    argue: (
      stance: "bull" | "bear",
      evidence: Evidence[],
    ) => Promise<Argument>;
  };
  now: () => Date;
  id?: () => string;
  evidenceMode?: "live" | "simulated";
  publisherRegistry?: Readonly<Record<string, string>>;
};
const articleOutputSchema = z.object({
  url: z.string().trim().pipe(z.url({ protocol: /^https?$/ })),
  text: z.string().trim().min(1).max(40_000),
});
const newsResultSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().pipe(z.url({ protocol: /^https?$/ })),
  excerpt: z.string().trim().min(1),
});
const newsResultsSchema = z.array(newsResultSchema).max(5);
const publisherIdentitySchema = z.object({
  domain: z.string().trim().min(1),
  id: z.string().trim().min(1),
}).strict();
const articleEvidencePayloadSchema = z.object({
  text: z.string(),
  publisher: publisherIdentitySchema.nullable(),
}).strict();
const newsEvidencePayloadSchema = newsResultSchema.extend({
  publisher: publisherIdentitySchema,
}).strict();
const extractedClaimSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
});
const extractedClaimsSchema = z
  .array(extractedClaimSchema)
  .max(3)
  .refine(
    (claims) => new Set(claims.map(({ id }) => id)).size === claims.length,
  );
const claimVerificationSchema = z.object({
  claimId: z.string().trim().min(1).max(64),
  status: z.enum(["verified", "disputed", "unsupported"]),
  evidenceIds: z
    .array(z.string().trim().min(1).max(128))
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length),
  explanation: z.string().trim().min(1).max(1_000),
}).strict().refine(
  ({ status, evidenceIds }) => status === "unsupported" || evidenceIds.length > 0,
);
const jsonObjectSchema = z.record(z.string(), z.json());
const ryoResultSchema = z.object({
  tool: z.string().trim().min(1),
  status: z.enum(["ok", "partial", "unavailable"]),
  dataMode: z.enum(["live", "mixed", "simulated", "unknown"]),
  asOf: z.string().datetime(),
  request: jsonObjectSchema,
  data: z.json(),
  availability: jsonObjectSchema,
  summary: z.string().trim().min(1),
  warnings: z.array(z.string()),
});
const ryoEvidencePayloadSchema = z.object({
  request: jsonObjectSchema,
  data: z.json(),
  availability: jsonObjectSchema,
}).strict();

const marketOverviewDataSchema = z.object({
  regime: z.string().trim().min(1),
  fear_greed: z.number().finite().min(0).max(100).optional(),
});
const analyzeTokenDataSchema = z.object({
  market: z.object({ price_usd: z.number().positive() }),
  technicals: z.object({
    atr_14: z.number().positive(),
    rsi: z.number().finite().min(0).max(100).optional(),
  }),
});
const deepAnalysisDataSchema = z.object({
  catalysts: z.array(z.string().trim().min(1)).max(50),
  risks: z.array(z.string().trim().min(1)).max(50),
  verdict: z.string().trim().min(1).optional(),
});
const sentimentShiftDataSchema = z.object({
  direction: z.string().trim().min(1),
  window: z.string().trim().min(1).optional(),
  change: z.number().finite().optional(),
});
const ryoDataSchemas: Readonly<Record<string, z.ZodType>> = {
  market_overview: marketOverviewDataSchema,
  analyze_token: analyzeTokenDataSchema,
  deep_analysis: deepAnalysisDataSchema,
  monitor_market_sentiment_shift: sentimentShiftDataSchema,
};

const modelNameSchema = z.string().trim().min(1).max(200);
const receiptIdSchema = z.string().trim().min(1).max(128);
const evidenceModeSchema = z.enum(["live", "simulated"]);
const trackingParameters = new Set(["gclid", "fbclid", "mc_cid", "mc_eid"]);
const maxRyoAgeMs = 24 * 60 * 60 * 1_000;
const maxRyoFutureSkewMs = 5 * 60 * 1_000;
const requiredRyoAvailabilityKeys: Readonly<Record<string, readonly string[]>> = {
  market_overview: ["market"],
  analyze_token: ["market", "technicals"],
  deep_analysis: ["primary", "derivatives"],
  monitor_market_sentiment_shift: ["sentiment"],
};

type JsonObject = z.infer<typeof jsonObjectSchema>;
type PublisherIdentity = z.infer<typeof publisherIdentitySchema>;
type IndependentNewsResult = NewsResult & { publisher: PublisherIdentity };
type ValidatedRyoResult = Omit<
  z.infer<typeof ryoResultSchema>,
  "request" | "availability"
> & {
  request: JsonObject;
  availability: JsonObject;
};

type RyoRequest = Readonly<{
  tool: string;
  arguments: Record<string, unknown>;
}>;

export function canonicalizeSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source URL must use HTTP(S)");
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const retainedParameters = [...url.searchParams.entries()]
    .filter(([key]) => {
      const normalizedKey = key.toLowerCase();
      return !normalizedKey.startsWith("utm_") &&
        !trackingParameters.has(normalizedKey);
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    );
  url.search = "";
  for (const [key, value] of retainedParameters) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

export function publisherKey(rawUrl: string): string | null {
  return getDomain(canonicalizeSourceUrl(rawUrl));
}

function registeredPublisherIdentity(
  rawUrl: string,
  publisherRegistry: Readonly<Record<string, string>>,
): PublisherIdentity | null {
  const domain = publisherKey(rawUrl);
  if (!domain) return null;
  const id = publisherRegistry[domain]?.trim();
  return id ? { domain, id } : null;
}

function filterIndependentNews(
  articleUrl: string,
  news: NewsResult[],
  publisherRegistry: Readonly<Record<string, string>>,
): IndependentNewsResult[] {
  const canonicalArticleUrl = canonicalizeSourceUrl(articleUrl);
  const articlePublisher = registeredPublisherIdentity(
    canonicalArticleUrl,
    publisherRegistry,
  );
  if (!articlePublisher) return [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  const seenPublisherIds = new Set<string>();

  return news.flatMap((item) => {
    const canonicalUrl = canonicalizeSourceUrl(item.url);
    const publisher = registeredPublisherIdentity(canonicalUrl, publisherRegistry);
    if (
      !publisher ||
      canonicalUrl === canonicalArticleUrl ||
      publisher.domain === articlePublisher.domain ||
      publisher.id === articlePublisher.id ||
      seenUrls.has(canonicalUrl) ||
      seenDomains.has(publisher.domain) ||
      seenPublisherIds.has(publisher.id)
    ) {
      return [];
    }
    seenUrls.add(canonicalUrl);
    seenDomains.add(publisher.domain);
    seenPublisherIds.add(publisher.id);
    return [{ ...item, url: canonicalUrl, publisher }];
  });
}

const ryoRequests = (symbol: string): RyoRequest[] => [
  { tool: "market_overview", arguments: {} },
  { tool: "analyze_token", arguments: { symbol } },
  { tool: "deep_analysis", arguments: { symbol, include_perp: true } },
  {
    tool: "monitor_market_sentiment_shift",
    arguments: { time_window: "7d" },
  },
];

const fallbackArgumentValues = [
  {
    stance: "bull",
    thesis: "Model unavailable; no bullish argument was produced.",
    confidence: 0,
    citations: ["article-1"],
  },
  {
    stance: "bear",
    thesis: "Model unavailable; no bearish argument was produced.",
    confidence: 0,
    citations: ["article-1"],
  },
] as const;

function fallbackArguments(): [
  z.infer<typeof bullArgumentSchema>,
  z.infer<typeof bearArgumentSchema>,
] {
  return [
    bullArgumentSchema.parse(fallbackArgumentValues[0]),
    bearArgumentSchema.parse(fallbackArgumentValues[1]),
  ];
}

function argumentsAreFallback(arguments_: Receipt["arguments"]): boolean {
  return canonicalJson(arguments_) === canonicalJson(fallbackArgumentValues);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function immutableJsonSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function appendReasonCodes(
  domainReasons: readonly ReasonCode[],
  modelUnavailable: boolean,
  insufficientEvidence: boolean,
): ReasonCode[] {
  const reasons: ReasonCode[] = [...domainReasons];
  if (modelUnavailable) reasons.push("MODEL_UNAVAILABLE");
  if (insufficientEvidence) reasons.push("INSUFFICIENT_EVIDENCE");
  return [...new Set(reasons)];
}

function requestContainsExpected(
  actual: JsonObject,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(actual, key) &&
    canonicalJson(actual[key]) === canonicalJson(value)
  );
}

function requiredAvailabilityKeys(tool: string): readonly string[] {
  return requiredRyoAvailabilityKeys[tool] ?? [];
}

function unavailableAvailability(tool: string): JsonObject {
  return Object.fromEntries(
    requiredAvailabilityKeys(tool).map((key) => [key, false]),
  );
}

function ryoAvailabilityIsUsable(tool: string, availability: JsonObject): boolean {
  const requiredKeys = requiredAvailabilityKeys(tool);
  return requiredKeys.length > 0 && requiredKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(availability, key) &&
    (availability[key] === true || availability[key] === "available")
  );
}

function validateRyoData(tool: string, data: unknown): boolean {
  return ryoDataSchemas[tool]?.safeParse(data).success ?? false;
}

function unavailableRyoResult(
  request: RyoRequest,
  asOf: string,
): ValidatedRyoResult {
  return {
    tool: request.tool,
    status: "unavailable",
    dataMode: "unknown",
    asOf,
    request: jsonObjectSchema.parse(request.arguments),
    data: { available: false },
    availability: unavailableAvailability(request.tool),
    summary: `Pipeline fallback: ${request.tool} is unavailable.`,
    warnings: ["Pipeline fallback replaced unavailable RYO evidence."],
  };
}

async function collectRyoResults(
  deps: AnalysisDependencies,
  symbol: string,
  retrievedAt: string,
): Promise<ValidatedRyoResult[]> {
  const requests = ryoRequests(symbol);
  const settled = await Promise.allSettled(
    requests.map((request) =>
      Promise.resolve().then(() =>
        deps.ryo.call(request.tool, request.arguments)
      )
    ),
  );

  return settled.map((result, index) => {
    const request = requests[index]!;
    if (result.status === "rejected") {
      return unavailableRyoResult(request, retrievedAt);
    }

    const parsed = ryoResultSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.tool !== request.tool) {
      return unavailableRyoResult(request, retrievedAt);
    }

    if (!requestContainsExpected(parsed.data.request, request.arguments)) {
      return unavailableRyoResult(request, retrievedAt);
    }
    if (!validateRyoData(request.tool, parsed.data.data)) {
      return unavailableRyoResult(request, retrievedAt);
    }

    return parsed.data;
  });
}

function unsupportedClaims(
  extractedClaims: ExtractedClaim[],
  explanation: string,
): Claim[] {
  return extractedClaims.map((claim) => ({
    ...claim,
    status: "unsupported",
    evidenceIds: [],
    explanation,
  }));
}

function parseClaimVerifications(
  raw: unknown,
  extractedClaims: ExtractedClaim[],
  newsEvidence: VerificationNewsEvidence[],
): ClaimVerification[] | null {
  const parsed = z.array(claimVerificationSchema).max(3).safeParse(raw);
  if (!parsed.success) return null;

  const claimIds = new Set(extractedClaims.map(({ id }) => id));
  const newsIds = new Set(newsEvidence.map(({ id }) => id));
  const returnedIds = parsed.data.map(({ claimId }) => claimId);
  if (
    returnedIds.length !== claimIds.size ||
    new Set(returnedIds).size !== returnedIds.length ||
    returnedIds.some((id) => !claimIds.has(id)) ||
    parsed.data.some(({ evidenceIds }) =>
      evidenceIds.some((id) => !newsIds.has(id))
    )
  ) {
    return null;
  }

  return parsed.data;
}

async function verifyExtractedClaims(
  deps: AnalysisDependencies,
  extractedClaims: ExtractedClaim[],
  newsEvidence: VerificationNewsEvidence[],
): Promise<{ claims: Claim[]; unavailable: boolean }> {
  if (newsEvidence.length === 0) {
    return {
      claims: unsupportedClaims(
        extractedClaims,
        "No independent news source was found for this claim.",
      ),
      unavailable: false,
    };
  }

  try {
    const raw = await Promise.resolve().then(() =>
      deps.llm.verifyClaims(
        immutableJsonSnapshot(extractedClaims),
        immutableJsonSnapshot(newsEvidence),
      )
    );
    const verifications = parseClaimVerifications(
      raw,
      extractedClaims,
      newsEvidence,
    );
    if (!verifications) throw new Error();
    const byClaimId = new Map(
      verifications.map((verification) => [verification.claimId, verification]),
    );
    return {
      claims: extractedClaims.map((claim) => {
        const verification = byClaimId.get(claim.id)!;
        return {
          ...claim,
          status: verification.status,
          evidenceIds: verification.evidenceIds,
          explanation: verification.explanation,
        };
      }),
      unavailable: false,
    };
  } catch {
    return {
      claims: unsupportedClaims(
        extractedClaims,
        "Claim verification is unavailable.",
      ),
      unavailable: true,
    };
  }
}

async function collectArguments(
  deps: AnalysisDependencies,
  evidence: Evidence[],
): Promise<{
  arguments: Receipt["arguments"];
  unavailable: boolean;
}> {
  const [bullResult, bearResult] = await Promise.allSettled([
    Promise.resolve().then(() =>
      deps.llm.argue("bull", immutableJsonSnapshot(evidence))
    ),
    Promise.resolve().then(() =>
      deps.llm.argue("bear", immutableJsonSnapshot(evidence))
    ),
  ]);
  if (bullResult.status !== "fulfilled" || bearResult.status !== "fulfilled") {
    return { arguments: fallbackArguments(), unavailable: true };
  }

  const bull = bullArgumentSchema.safeParse(bullResult.value);
  const bear = bearArgumentSchema.safeParse(bearResult.value);
  if (!bull.success || !bear.success) {
    return { arguments: fallbackArguments(), unavailable: true };
  }

  const arguments_: Receipt["arguments"] = [bull.data, bear.data];
  return {
    arguments: arguments_,
    unavailable: argumentsAreFallback(arguments_),
  };
}

function evidenceHashesAreValid(evidence: Evidence[]): boolean {
  return evidence.every(({ hash, ...partial }) => hash === sha256(partial));
}

function valuesAreUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function receiptIdentifiersAreValid(
  receipt: Pick<Receipt, "evidence" | "claims" | "arguments">,
): boolean {
  const evidenceIds = receipt.evidence.map(({ id }) => id);
  if (!valuesAreUnique(evidenceIds)) return false;

  const claimIds = receipt.claims.map(({ id }) => id);
  if (!valuesAreUnique(claimIds)) return false;

  const knownEvidenceIds = new Set(evidenceIds);
  if (receipt.claims.some(({ evidenceIds: claimEvidenceIds }) =>
    !valuesAreUnique(claimEvidenceIds) ||
    claimEvidenceIds.some((id) => !knownEvidenceIds.has(id))
  )) {
    return false;
  }

  return receipt.arguments.every(({ citations }) => valuesAreUnique(citations));
}

function inferEvidenceMode(evidence: Evidence[]): "live" | "simulated" {
  const articleAndNews = evidence.filter(
    ({ kind }) => kind === "article" || kind === "news",
  );
  return articleAndNews.some(({ dataMode }) => dataMode === "simulated")
    ? "simulated"
    : "live";
}

function ryoTimestampIsFresh(observedAt: string | null, decisionAt: string): boolean {
  if (!observedAt) return false;
  const observedAtMs = Date.parse(observedAt);
  const decisionAtMs = Date.parse(decisionAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(decisionAtMs)) {
    return false;
  }
  const ageMs = decisionAtMs - observedAtMs;
  return ageMs <= maxRyoAgeMs && ageMs >= -maxRyoFutureSkewMs;
}

function deriveMarketInputs(
  evidence: Evidence[],
  token: string,
  evidenceMode: "live" | "simulated",
  decisionAt: string,
): { marketEvidenceUsable: boolean; price: number | null; atr: number | null } {
  const requests = ryoRequests(token);
  const ryoEvidence = evidence.filter(({ kind }) => kind === "ryo");
  const modeIsConsistent = evidenceMode === "simulated"
    ? evidence.every(({ dataMode }) =>
        dataMode === "simulated" || dataMode === "unknown"
      )
    : evidence
      .filter(({ kind, status }) =>
        (kind === "article" || kind === "news") && status !== "unavailable"
      )
      .every(({ dataMode }) => dataMode === "live");

  const normalized = requests.map((request, index) => {
    const matching = ryoEvidence.filter(({ source }) => source === request.tool);
    const item = matching.length === 1 ? matching[0] : undefined;
    const payload = item
      ? ryoEvidencePayloadSchema.safeParse(item.payload)
      : null;
    const expectedId = `ryo-${index + 1}`;
    const usableMode = item
      ? evidenceMode === "simulated"
        ? item.dataMode === "simulated"
        : item.dataMode === "live"
      : false;
    const usable = Boolean(
      item &&
      item.id === expectedId &&
      item.status !== "unavailable" &&
      usableMode &&
      payload?.success &&
      requestContainsExpected(payload.data.request, request.arguments) &&
      ryoAvailabilityIsUsable(request.tool, payload.data.availability) &&
      validateRyoData(request.tool, payload.data.data) &&
      ryoTimestampIsFresh(item.observedAt, decisionAt),
    );
    return { payload, usable };
  });

  const tokenPayload = normalized[1]?.payload;
  const tokenData = tokenPayload?.success
    ? analyzeTokenDataSchema.safeParse(tokenPayload.data.data)
    : null;
  return {
    marketEvidenceUsable:
      modeIsConsistent &&
      normalized.length === requests.length &&
      normalized.every(({ usable }) => usable),
    price: tokenData?.success ? tokenData.data.market.price_usd : null,
    atr: tokenData?.success ? tokenData.data.technicals.atr_14 : null,
  };
}

function independentNewsEvidence(evidence: Evidence[]): Evidence[] {
  const articles = evidence.filter(
    ({ kind, status }) => kind === "article" && status !== "unavailable",
  );
  if (articles.length !== 1) return [];

  try {
    const articleUrl = canonicalizeSourceUrl(articles[0]!.source);
    const articlePayload = articleEvidencePayloadSchema.safeParse(
      articles[0]!.payload,
    );
    if (!articlePayload.success || !articlePayload.data.publisher) return [];
    const articlePublisher = articlePayload.data.publisher;
    if (publisherKey(articleUrl) !== articlePublisher.domain) return [];
    const seenUrls = new Set<string>();
    const seenDomains = new Set<string>();
    const seenPublisherIds = new Set<string>();
    const independent: Evidence[] = [];
    for (const item of evidence) {
      if (item.kind !== "news" || item.status === "unavailable") continue;
      const payload = newsEvidencePayloadSchema.safeParse(item.payload);
      if (!payload.success) return [];
      const sourceUrl = canonicalizeSourceUrl(item.source);
      if (sourceUrl !== canonicalizeSourceUrl(payload.data.url)) return [];
      const publisher = payload.data.publisher;
      if (publisherKey(sourceUrl) !== publisher.domain) return [];
      if (
        sourceUrl === articleUrl ||
        publisher.domain === articlePublisher.domain ||
        publisher.id === articlePublisher.id ||
        seenUrls.has(sourceUrl) ||
        seenDomains.has(publisher.domain) ||
        seenPublisherIds.has(publisher.id)
      ) {
        return [];
      }
      seenUrls.add(sourceUrl);
      seenDomains.add(publisher.domain);
      seenPublisherIds.add(publisher.id);
      independent.push(item);
    }
    return independent;
  } catch {
    return [];
  }
}

function hasUsableNews(evidence: Evidence[]): boolean {
  return independentNewsEvidence(evidence).length > 0;
}

function claimsReferenceNews(claims: Claim[], evidence: Evidence[]): boolean {
  const newsIds = new Set(independentNewsEvidence(evidence).map(({ id }) => id));
  return claims.every((claim) =>
    claim.evidenceIds.every((id) => newsIds.has(id)) &&
    ((claim.status === "verified" || claim.status === "disputed")
      ? claim.evidenceIds.length > 0
      : true)
  );
}

function proposedVerdict(arguments_: Receipt["arguments"]): Receipt["verdict"] {
  const [bull, bear] = arguments_;
  if (bull.confidence > bear.confidence) return "LONG";
  if (bear.confidence > bull.confidence) return "SHORT";
  return "NO_TRADE";
}

function deriveDecision(
  receipt: Pick<
    Receipt,
    "createdAt" | "input" | "evidence" | "claims" | "arguments"
  >,
  modelUnavailable: boolean,
  insufficientEvidence: boolean,
) {
  const evidenceIds = new Set(receipt.evidence.map(({ id }) => id));
  const missingCitations = [
    ...validateCitations(receipt.arguments[0].citations, evidenceIds),
    ...validateCitations(receipt.arguments[1].citations, evidenceIds),
  ];
  const market = deriveMarketInputs(
    receipt.evidence,
    receipt.input.token,
    inferEvidenceMode(receipt.evidence),
    receipt.createdAt,
  );
  const domainDecision = decide({
    claimStatuses: receipt.claims.map(({ status }) => status),
    marketEvidenceUsable: market.marketEvidenceUsable,
    missingCitations,
    proposedVerdict: proposedVerdict(receipt.arguments),
    price: market.price,
    atr: market.atr,
    riskLevel: receipt.input.riskLevel,
    bullConfidence: receipt.arguments[0].confidence,
    bearConfidence: receipt.arguments[1].confidence,
  });
  const reasonCodes = appendReasonCodes(
    domainDecision.reasonCodes,
    modelUnavailable,
    insufficientEvidence,
  );

  return modelUnavailable
    ? {
        verdict: "NO_TRADE" as const,
        confidence: 0,
        reasonCodes,
        riskPlan: null,
      }
    : { ...domainDecision, reasonCodes };
}

function buildCausalChain(
  claims: Claim[],
  arguments_: Receipt["arguments"],
): string[] {
  return [
    ...claims.map((claim) =>
      `claim:${claim.id}:${claim.status}:${sha256({
        text: claim.text,
        evidenceIds: claim.evidenceIds,
        explanation: claim.explanation,
      })}`
    ),
    `arguments:${sha256(arguments_)}`,
  ];
}

export function replayReceipt(rawReceipt: unknown): {
  evidenceHash: string;
  identical: boolean;
} {
  const parsed = receiptSchema.safeParse(rawReceipt);
  if (!parsed.success) return { evidenceHash: "", identical: false };

  const receipt = parsed.data;
  const evidenceHash = sha256(receipt.evidence);
  if (!receiptIdentifiersAreValid(receipt)) {
    return { evidenceHash, identical: false };
  }
  try {
    const modelUnavailable = argumentsAreFallback(receipt.arguments);
    const insufficientEvidence =
      receipt.claims.length === 0 || !hasUsableNews(receipt.evidence);
    const expectedDecision = deriveDecision(
      receipt,
      modelUnavailable,
      insufficientEvidence,
    );
    const expectedCausalChain = buildCausalChain(
      receipt.claims,
      receipt.arguments,
    );
    const identical =
      evidenceHashesAreValid(receipt.evidence) &&
      claimsReferenceNews(receipt.claims, receipt.evidence) &&
      receipt.replay.evidenceHash === evidenceHash &&
      canonicalJson({
        verdict: receipt.verdict,
        confidence: receipt.confidence,
        reasonCodes: receipt.reasonCodes,
        riskPlan: receipt.riskPlan,
        causalChain: receipt.causalChain,
      }) === canonicalJson({
        ...expectedDecision,
        causalChain: expectedCausalChain,
      });
    return { evidenceHash, identical };
  } catch {
    return { evidenceHash, identical: false };
  }
}

function readAnalysisTimestamp(deps: AnalysisDependencies): string {
  let now: Date;
  try {
    now = deps.now();
  } catch {
    throw new Error("Analysis clock failed");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Analysis timestamp is invalid");
  }
  return now.toISOString();
}

function readModelName(deps: AnalysisDependencies): string {
  try {
    return modelNameSchema.parse(deps.llm.model);
  } catch {
    throw new Error("Model configuration is invalid");
  }
}

async function fetchArticleEvidence(
  deps: AnalysisDependencies,
  articleUrl: string,
) {
  try {
    return articleOutputSchema.parse(
      await Promise.resolve().then(() => deps.articleFetcher(articleUrl)),
    );
  } catch {
    throw new Error("Article evidence unavailable");
  }
}

function generateReceiptId(deps: AnalysisDependencies): string {
  try {
    return receiptIdSchema.parse(deps.id?.() ?? randomUUID());
  } catch {
    throw new Error("Receipt id generation failed");
  }
}

export function createAnalysisPipeline(deps: AnalysisDependencies) {
  const evidenceMode = evidenceModeSchema.parse(deps.evidenceMode ?? "live");
  const publisherRegistry: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(deps.publisherRegistry ?? {}).map(([domain, id]) => [
      domain.trim().toLowerCase(),
      id,
    ]),
  );

  return {
    async run(rawInput: unknown) {
      const input = analysisRequestSchema.parse(rawInput);
      const retrievedAt = readAnalysisTimestamp(deps);
      const modelName = readModelName(deps);
      const article = await fetchArticleEvidence(deps, input.articleUrl);
      const articleUrl = canonicalizeSourceUrl(article.url);
      const articlePublisher = registeredPublisherIdentity(
        articleUrl,
        publisherRegistry,
      );

      let modelUnavailable = false;
      let extractedClaims: ExtractedClaim[] = [];
      try {
        extractedClaims = extractedClaimsSchema.parse(
          await Promise.resolve().then(() =>
            deps.llm.extractClaims(article.text)
          ),
        );
      } catch {
        modelUnavailable = true;
      }

      let newsUnavailable = false;
      let news: NewsResult[] = [];
      if (!modelUnavailable && extractedClaims.length > 0) {
        try {
          news = newsResultsSchema.parse(
            await Promise.resolve().then(() =>
              deps.newsSearcher(
                extractedClaims.map(({ text }) => text).join(" "),
              )
            ),
          );
        } catch {
          newsUnavailable = true;
        }
      }

      const independentNews = filterIndependentNews(
        articleUrl,
        news,
        publisherRegistry,
      );
      const verificationNews: VerificationNewsEvidence[] = independentNews.map(
        ({ title, url, excerpt }, index) => ({
          id: `news-${index + 1}`,
          title,
          url,
          excerpt,
        }),
      );
      const verification = modelUnavailable
        ? {
            claims: unsupportedClaims(
              extractedClaims,
              "Claim verification is unavailable.",
            ),
            unavailable: true,
          }
        : await verifyExtractedClaims(deps, extractedClaims, verificationNews);
      modelUnavailable = modelUnavailable || verification.unavailable;

      const ryoResults = await collectRyoResults(
        deps,
        input.token,
        retrievedAt,
      );
      const evidence: Evidence[] = [];
      const addEvidence = (partial: Omit<Evidence, "hash">) => {
        evidence.push({ ...partial, hash: sha256(partial) });
      };

      addEvidence({
        id: "article-1",
        kind: "article",
        source: articleUrl,
        retrievedAt,
        observedAt: null,
        status: "ok",
        dataMode: evidenceMode,
        payload: { text: article.text, publisher: articlePublisher },
        summary: article.text.slice(0, 180),
        warnings: [],
      });

      if (newsUnavailable) {
        addEvidence({
          id: "news-1",
          kind: "news",
          source: "independent-news-search",
          retrievedAt,
          observedAt: null,
          status: "unavailable",
          dataMode: "unknown",
          payload: { available: false },
          summary: "Independent news search is unavailable.",
          warnings: ["Independent news evidence is unavailable."],
        });
      } else {
        independentNews.forEach((item, index) => {
          addEvidence({
            id: `news-${index + 1}`,
            kind: "news",
            source: item.url,
            retrievedAt,
            observedAt: null,
            status: "ok",
            dataMode: evidenceMode,
            payload: {
              title: item.title,
              url: item.url,
              excerpt: item.excerpt,
              publisher: item.publisher,
            },
            summary: item.excerpt,
            warnings: [],
          });
        });
      }

      ryoResults.forEach((item, index) => {
        addEvidence({
          id: `ryo-${index + 1}`,
          kind: "ryo",
          source: item.tool,
          retrievedAt,
          observedAt: item.status === "unavailable" ? null : item.asOf,
          status: item.status,
          dataMode: item.dataMode,
          payload: {
            request: item.request,
            data: item.data,
            availability: item.availability,
          },
          summary: item.summary,
          warnings: item.warnings,
        });
      });

      let debate: Awaited<ReturnType<typeof collectArguments>>;
      if (modelUnavailable) {
        debate = { arguments: fallbackArguments(), unavailable: true };
      } else {
        debate = await collectArguments(deps, evidence);
        modelUnavailable = debate.unavailable;
      }

      if (!evidenceHashesAreValid(evidence)) {
        throw new Error("Evidence integrity check failed");
      }
      if (!receiptIdentifiersAreValid({
        evidence,
        claims: verification.claims,
        arguments: debate.arguments,
      })) {
        throw new Error("Receipt identifier integrity check failed");
      }

      const insufficientEvidence =
        verification.claims.length === 0 || !hasUsableNews(evidence);
      const decision = deriveDecision(
        {
          createdAt: retrievedAt,
          input,
          evidence,
          claims: verification.claims,
          arguments: debate.arguments,
        },
        modelUnavailable,
        insufficientEvidence,
      );
      const causalChain = buildCausalChain(
        verification.claims,
        debate.arguments,
      );
      const evidenceHash = sha256(evidence);
      const candidate = receiptSchema.parse({
        schemaVersion: "1.0",
        id: generateReceiptId(deps),
        createdAt: retrievedAt,
        input,
        evidence,
        claims: verification.claims,
        arguments: debate.arguments,
        ...decision,
        causalChain,
        model: { name: modelName, promptVersion },
        replay: { evidenceHash, identical: false },
      });
      const replay = replayReceipt(candidate);
      return receiptSchema.parse({ ...candidate, replay });
    },
  };
}
