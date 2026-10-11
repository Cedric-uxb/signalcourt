import type { AnalysisDependencies, RyoResult } from "./pipeline.js";

const FIXED_TIME = "2026-10-08T12:00:00.000Z";

const ryoResults: Record<string, RyoResult> = {
  market_overview: {
    tool: "market_overview",
    status: "ok",
    dataMode: "simulated",
    asOf: FIXED_TIME,
    data: { regime: "neutral", fixture: "Demo/Simulated" },
    summary: "Demo/Simulated market regime is neutral.",
    warnings: [],
  },
  analyze_token: {
    tool: "analyze_token",
    status: "ok",
    dataMode: "simulated",
    asOf: FIXED_TIME,
    data: {
      market: { price_usd: 100 },
      technicals: { atr_14: 5 },
      fixture: "Demo/Simulated",
    },
    summary: "Demo/Simulated SOL data has balanced momentum.",
    warnings: [],
  },
  deep_analysis: {
    tool: "deep_analysis",
    status: "partial",
    dataMode: "simulated",
    asOf: FIXED_TIME,
    data: {
      catalysts: ["simulated filing confirmation"],
      risks: ["simulated catalyst may be priced in"],
      fixture: "Demo/Simulated",
    },
    summary: "Demo/Simulated evidence is mixed.",
    warnings: ["Derivatives are unavailable in this simulated fixture."],
  },
  monitor_market_sentiment_shift: {
    tool: "monitor_market_sentiment_shift",
    status: "ok",
    dataMode: "simulated",
    asOf: FIXED_TIME,
    data: { direction: "improving", fixture: "Demo/Simulated" },
    summary: "Demo/Simulated sentiment is improving.",
    warnings: [],
  },
};

export function createDemoDependencies(
  mode: "supported" | "insufficient",
): AnalysisDependencies {
  const citation = mode === "supported" ? "news-1" : "article-1";

  return {
    evidenceMode: "simulated",
    articleFetcher: async (url) => ({
      url,
      text: "Demo/Simulated article: an issuer reports a regulated market filing.",
    }),
    newsSearcher: async () => mode === "supported"
      ? [{
          title: "Demo/Simulated independent filing report",
          url: "https://example.org/filing",
          excerpt: "Demo/Simulated public register lists the filing.",
        }]
      : [],
    ryo: {
      call: async (tool) => {
        const result = ryoResults[tool];
        if (!result) throw new Error("Unknown simulated RYO tool");
        return result;
      },
    },
    llm: {
      model: "signalcourt-demo-simulated-v1",
      extractClaims: async () => [{
        id: "claim-1",
        text: "A Demo/Simulated regulated market filing was submitted.",
      }],
      argue: async (stance) => stance === "bull"
        ? {
            stance,
            thesis: "Demo/Simulated independent evidence supports a practice long.",
            confidence: 0.8,
            citations: [citation, "ryo-2", "ryo-4"],
          }
        : {
            stance,
            thesis: "Demo/Simulated filing may already be priced in.",
            confidence: 0.4,
            citations: [citation, "ryo-3"],
          },
    },
    now: () => new Date(FIXED_TIME),
    id: () => `demo-${mode}`,
  };
}
