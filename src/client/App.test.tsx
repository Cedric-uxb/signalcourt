// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Receipt } from "../shared/contracts";
import { App } from "./App";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const receipt: Receipt = {
  schemaVersion: "1.1",
  id: "receipt-demo-10",
  createdAt: "2026-10-08T12:00:00.000Z",
  input: {
    articleUrl: "https://news.example.org/solana-filing",
    token: "SOL",
    riskLevel: "balanced",
  },
  evidence: [
    {
      id: "news-1",
      hash: HASH_A,
      kind: "news",
      source: "Public filing register",
      retrievedAt: "2026-10-08T12:00:00.000Z",
      observedAt: "2026-10-08T11:45:00.000Z",
      status: "ok",
      dataMode: "simulated",
      payload: { title: "Independent filing confirmation" },
      summary: "An independent register confirms the filing.",
      warnings: ["Demo evidence is simulated."],
    },
  ],
  claims: [
    {
      id: "claim-1",
      text: "A regulated market filing was submitted.",
      status: "verified",
      evidenceIds: ["news-1"],
      explanation: "Independent evidence supports the claim.",
    },
  ],
  arguments: [
    {
      stance: "bull",
      thesis: "The verified filing supports a positive practice case.",
      confidence: 0.78,
      citations: ["news-1"],
    },
    {
      stance: "bear",
      thesis: "The catalyst may already be priced in.",
      confidence: 0.42,
      citations: ["news-1"],
    },
  ],
  verdict: "LONG",
  confidence: 0.76,
  reasonCodes: ["CLAIM_DISPUTED"],
  causalChain: [
    `claim:claim-1:verified:${HASH_A}`,
    `arguments:${HASH_B}`,
  ],
  riskPlan: { entry: 100, stop: 95, target: 110, practiceSizeUsd: 250 },
  model: { name: "fixture-model", promptVersion: "test-v1" },
  replay: { evidenceHash: HASH_A, receiptHash: HASH_B, identical: true },
};

const system = {
  mode: "demo",
  capabilities: { ryo: false, news: false, model: false },
  demoAvailable: true,
  publisherRegistryConfigured: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockApi(analysisResponse: Response = jsonResponse(receipt, 201)) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/system") return jsonResponse(system);
    if (url === "/api/analyses") return analysisResponse;
    if (url === `/api/receipts/${receipt.id}/replay`) {
      return jsonResponse({ id: receipt.id, identical: true, evidenceHash: HASH_A });
    }
    return jsonResponse({ error: "NOT_FOUND" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function submitAnalysis() {
  fireEvent.change(screen.getByLabelText("News URL"), {
    target: { value: "https://news.example.org/solana-filing" },
  });
  fireEvent.change(screen.getByLabelText("Token symbol"), {
    target: { value: "sol" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));
  await screen.findByRole("heading", { name: "LONG" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SignalCourt workspace", () => {
  it("renders a decision-first idle workspace with responsible-use guidance", async () => {
    mockApi();
    render(<App />);

    expect(screen.getByRole("heading", { name: "SignalCourt" })).toBeVisible();
    expect(screen.getByLabelText("News URL")).toHaveValue("");
    expect(screen.getByLabelText("Token symbol")).toBeVisible();
    expect(screen.getByRole("button", { name: "Analyze evidence" })).toBeVisible();
    expect(screen.getByText("Decision pending")).toBeVisible();
    expect(screen.getByText(/not financial advice/i)).toBeVisible();
    expect(await screen.findByText("Demo mode")).toBeVisible();
  });

  it("shows inline validation before sending an invalid request", async () => {
    const fetchMock = mockApi();
    render(<App />);

    fireEvent.change(screen.getByLabelText("Token symbol"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));

    expect(await screen.findByText("Enter a public HTTP(S) news URL.")).toBeVisible();
    expect(screen.getByText("Use 2-12 letters or numbers.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/analyses", expect.anything());
  });

  it("keeps an explicit loading state visible while evidence is collected", async () => {
    let resolveAnalysis!: (response: Response) => void;
    const pendingAnalysis = new Promise<Response>((resolve) => { resolveAnalysis = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/system") return jsonResponse(system);
      return pendingAnalysis;
    }));
    render(<App />);

    fireEvent.change(screen.getByLabelText("News URL"), {
      target: { value: "https://news.example.org/solana-filing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));

    expect(await screen.findByRole("heading", { name: "Analysis in progress" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Analyzing evidence..." })).toBeDisabled();

    resolveAnalysis(jsonResponse(receipt, 201));
    expect(await screen.findByRole("heading", { name: "LONG" })).toBeVisible();
  });

  it("submits normalized input and renders the complete evidence path", async () => {
    const fetchMock = mockApi();
    render(<App />);

    await submitAnalysis();

    expect(fetchMock).toHaveBeenCalledWith("/api/analyses", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        articleUrl: "https://news.example.org/solana-filing",
        token: "SOL",
        riskLevel: "balanced",
      }),
    }));
    expect(screen.getByText("76% confidence")).toBeVisible();
    expect(screen.getByText("Claim disputed")).toBeVisible();
    expect(screen.getByText("Claim claim-1 was verified (audit aaaaaaaa)."))
      .toBeVisible();
    expect(screen.getByText("Bull and bear cases were bound to the same evidence pack (audit bbbbbbbb)."))
      .toBeVisible();
    expect(screen.getByText("A regulated market filing was submitted.")).toBeVisible();
    expect(screen.getByText("Bull case")).toBeVisible();
    expect(screen.getByText("Public filing register")).toBeVisible();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
  });

  it("surfaces a bounded error and keeps the form usable", async () => {
    mockApi(jsonResponse({ error: "ANALYSIS_UNAVAILABLE" }, 503));
    render(<App />);

    fireEvent.change(screen.getByLabelText("News URL"), {
      target: { value: "https://news.example.org/outage" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Analysis service is temporarily unavailable. Try again.",
    );
    expect(screen.getByRole("button", { name: "Analyze evidence" })).toBeEnabled();
  });

  it("updates the accessible mobile workspace tabs", async () => {
    mockApi();
    render(<App />);
    await submitAnalysis();

    const tabs = screen.getByRole("tablist", { name: "Analysis views" });
    const claimsTab = within(tabs).getByRole("tab", { name: "Claims" });
    fireEvent.click(claimsTab);

    expect(claimsTab).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: "Decision" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("replays the stored receipt through the API and reports verification", async () => {
    const fetchMock = mockApi();
    render(<App />);
    await submitAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Replay receipt" }));

    expect(await screen.findByText("Replay matched stored decision")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/receipts/${receipt.id}/replay`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("gives visible guidance when clipboard access is unavailable", async () => {
    mockApi();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    render(<App />);
    await submitAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Copy receipt ID" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Clipboard unavailable. Select the receipt ID to copy it.",
    );
  });
});
