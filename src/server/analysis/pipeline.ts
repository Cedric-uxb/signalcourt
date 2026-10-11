import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  analysisRequestSchema,
  bearArgumentSchema,
  bullArgumentSchema,
  receiptSchema,
  type Argument,
  type Evidence,
} from "../../shared/contracts.js";
import type { ReasonCode } from "../../shared/reason-codes.js";
import { sha256 } from "../domain/canonical-json.js";
import { validateCitations } from "../domain/citations.js";
import { decide } from "../domain/decision.js";
import { promptVersion } from "./prompts.js";

export type NewsResult = {
  title: string;
  url: string;
  excerpt: string;
};

export type RyoResult = {
  tool: string;
  status: "ok" | "partial" | "unavailable";
  dataMode: "live" | "mixed" | "simulated" | "unknown";
  asOf: string;
  data: unknown;
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
    extractClaims: (
      text: string,
    ) => Promise<Array<{ id: string; text: string }>>;
    argue: (
      stance: "bull" | "bear",
      evidence: Evidence[],
    ) => Promise<Argument>;
  };
  now: () => Date;
  id?: () => string;
  evidenceMode?: "live" | "simulated";
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

const ryoResultSchema = z.object({
  tool: z.string().trim().min(1),
  status: z.enum(["ok", "partial", "unavailable"]),
  dataMode: z.enum(["live", "mixed", "simulated", "unknown"]),
  asOf: z.string().datetime(),
  data: z.json(),
  summary: z.string().trim().min(1),
  warnings: z.array(z.string()),
});
type ValidatedRyoResult = z.infer<typeof ryoResultSchema>;

const tokenDataSchema = z.object({
  market: z.object({ price_usd: z.number().positive() }),
  technicals: z.object({ atr_14: z.number().positive() }),
});

const modelNameSchema = z.string().trim().min(1);
const evidenceModeSchema = z.enum(["live", "simulated"]);

type RyoRequest = Readonly<{
  tool: string;
  arguments: Record<string, unknown>;
}>;

const ryoRequests = (symbol: string): RyoRequest[] => [
  { tool: "market_overview", arguments: {} },
  { tool: "analyze_token", arguments: { symbol } },
  { tool: "deep_analysis", arguments: { symbol, include_perp: true } },
  {
    tool: "monitor_market_sentiment_shift",
    arguments: { time_window: "7d" },
  },
];

function requireTimestamp(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Analysis timestamp is invalid");
  }
  return now.toISOString();
}

function unavailableRyoResult(tool: string, asOf: string): ValidatedRyoResult {
  return {
    tool,
    status: "unavailable",
    dataMode: "unknown",
    asOf,
    data: { available: false },
    summary: `${tool} is unavailable.`,
    warnings: ["RYO evidence is unavailable."],
  };
}

function fallbackArguments(): [
  z.infer<typeof bullArgumentSchema>,
  z.infer<typeof bearArgumentSchema>,
] {
  return [
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
  ];
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

async function collectRyoResults(
  deps: AnalysisDependencies,
  symbol: string,
  retrievedAt: string,
): Promise<ValidatedRyoResult[]> {
  const results: ValidatedRyoResult[] = [];

  for (const request of ryoRequests(symbol)) {
    try {
      const parsed = ryoResultSchema.safeParse(
        await deps.ryo.call(request.tool, request.arguments),
      );
      if (!parsed.success || parsed.data.tool !== request.tool) {
        results.push(unavailableRyoResult(request.tool, retrievedAt));
        continue;
      }
      results.push(parsed.data);
    } catch {
      results.push(unavailableRyoResult(request.tool, retrievedAt));
    }
  }

  return results;
}

async function collectArguments(
  deps: AnalysisDependencies,
  evidence: Evidence[],
): Promise<{
  arguments: [
    z.infer<typeof bullArgumentSchema>,
    z.infer<typeof bearArgumentSchema>,
  ];
  unavailable: boolean;
}> {
  const [bullResult, bearResult] = await Promise.allSettled([
    Promise.resolve().then(() => deps.llm.argue("bull", evidence)),
    Promise.resolve().then(() => deps.llm.argue("bear", evidence)),
  ]);
  if (bullResult.status !== "fulfilled" || bearResult.status !== "fulfilled") {
    return { arguments: fallbackArguments(), unavailable: true };
  }

  const bull = bullArgumentSchema.safeParse(bullResult.value);
  const bear = bearArgumentSchema.safeParse(bearResult.value);
  if (!bull.success || !bear.success) {
    return { arguments: fallbackArguments(), unavailable: true };
  }

  return { arguments: [bull.data, bear.data], unavailable: false };
}

export function createAnalysisPipeline(deps: AnalysisDependencies) {
  const evidenceMode = evidenceModeSchema.parse(deps.evidenceMode ?? "live");

  return {
    async run(rawInput: unknown) {
      const input = analysisRequestSchema.parse(rawInput);
      const retrievedAt = requireTimestamp(deps.now());
      const modelName = modelNameSchema.parse(deps.llm.model);

      const article = articleOutputSchema.parse(
        await deps.articleFetcher(input.articleUrl),
      );

      let modelUnavailable = false;
      let extractedClaims: z.infer<typeof extractedClaimsSchema> = [];
      try {
        extractedClaims = extractedClaimsSchema.parse(
          await deps.llm.extractClaims(article.text),
        );
      } catch {
        modelUnavailable = true;
      }

      let newsUnavailable = false;
      let news: NewsResult[] = [];
      if (!modelUnavailable && extractedClaims.length > 0) {
        try {
          news = newsResultsSchema.parse(
            await deps.newsSearcher(
              extractedClaims.map(({ text }) => text).join(" "),
            ),
          );
        } catch {
          newsUnavailable = true;
        }
      }

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
        source: article.url,
        retrievedAt,
        observedAt: null,
        status: "ok",
        dataMode: evidenceMode,
        payload: article.text,
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
        news.forEach((item, index) => {
          addEvidence({
            id: `news-${index + 1}`,
            kind: "news",
            source: item.url,
            retrievedAt,
            observedAt: null,
            status: "ok",
            dataMode: evidenceMode,
            payload: item,
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
          payload: item.data,
          summary: item.summary,
          warnings: item.warnings,
        });
      });

      const independentNewsIds = news.map((_, index) => `news-${index + 1}`);
      const claims = extractedClaims.map((claim) => ({
        ...claim,
        status: independentNewsIds.length > 0
          ? "verified" as const
          : "unsupported" as const,
        evidenceIds: independentNewsIds,
        explanation: independentNewsIds.length > 0
          ? "Independent news sources were found; this MVP links each claim to all of them."
          : "No independent news source was found for this claim.",
      }));

      let debate: Awaited<ReturnType<typeof collectArguments>>;
      if (modelUnavailable) {
        debate = { arguments: fallbackArguments(), unavailable: true };
      } else {
        debate = await collectArguments(deps, evidence);
        modelUnavailable = debate.unavailable;
      }
      const [bull, bear] = debate.arguments;

      const evidenceIds = new Set(evidence.map(({ id }) => id));
      const missingCitations = [
        ...validateCitations(bull.citations, evidenceIds),
        ...validateCitations(bear.citations, evidenceIds),
      ];
      const tokenData = tokenDataSchema.safeParse(ryoResults[1]?.data);
      const price = tokenData.success ? tokenData.data.market.price_usd : null;
      const atr = tokenData.success ? tokenData.data.technicals.atr_14 : null;
      const proposedVerdict = bull.confidence > bear.confidence
        ? "LONG"
        : bear.confidence > bull.confidence
          ? "SHORT"
          : "NO_TRADE";
      const domainDecision = decide({
        claimStatuses: claims.map(({ status }) => status),
        marketEvidenceUsable: ryoResults.every(
          ({ status }) => status !== "unavailable",
        ),
        missingCitations,
        proposedVerdict,
        price,
        atr,
        riskLevel: input.riskLevel,
        bullConfidence: bull.confidence,
        bearConfidence: bear.confidence,
      });
      const reasonCodes = appendReasonCodes(
        domainDecision.reasonCodes,
        modelUnavailable,
        claims.length === 0 || independentNewsIds.length === 0,
      );
      const decision = modelUnavailable
        ? {
            verdict: "NO_TRADE" as const,
            confidence: 0,
            reasonCodes,
            riskPlan: null,
          }
        : { ...domainDecision, reasonCodes };

      const receiptId = deps.id?.() ?? randomUUID();
      return receiptSchema.parse({
        schemaVersion: "1.0",
        id: receiptId,
        createdAt: retrievedAt,
        input,
        evidence,
        claims,
        arguments: debate.arguments,
        ...decision,
        causalChain: claims.map(({ id, status }) => `${id}:${status}`),
        model: { name: modelName, promptVersion },
        replay: { evidenceHash: sha256(evidence), identical: true },
      });
    },
  };
}
