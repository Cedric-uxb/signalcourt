// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Receipt } from "../shared/contracts";
import { App } from "./App";
import { ReceiptPanel } from "./components/ReceiptPanel";

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

const secondReceipt: Receipt = {
  ...receipt,
  id: "receipt-demo-11",
  input: {
    ...receipt.input,
    articleUrl: "https://news.example.org/second-analysis",
  },
  replay: {
    ...receipt.replay,
    receiptHash: "c".repeat(64),
  },
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

function mockViewport(initialMobile = false) {
  let matches = initialMobile;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = "(max-width: 820px)";

  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === media ? matches : false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));

  return {
    setMobile(next: boolean) {
      matches = next;
      const event = { matches: next, media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
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

beforeEach(() => {
  mockViewport();
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

  it("focuses and announces validation errors before sending an invalid request", async () => {
    const fetchMock = mockApi();
    render(<App />);

    fireEvent.change(screen.getByLabelText("Token symbol"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));

    const urlInput = screen.getByLabelText("News URL");
    expect(await screen.findByText("Enter a public HTTP(S) news URL.")).toBeVisible();
    expect(screen.getByText("Use 2-12 letters or numbers.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a public HTTP(S) news URL. Use 2-12 letters or numbers.",
    );
    expect(urlInput).toHaveFocus();
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
    expect(screen.getByText("76% Model debate score")).toBeVisible();
    expect(screen.getByText("This score is not an outcome probability.")).toBeVisible();
    expect(screen.getByText("Claim disputed")).toBeVisible();
    expect(screen.getByText("Claim claim-1 was verified (audit aaaaaaaa)."))
      .toBeVisible();
    expect(screen.getByText("Bull and bear cases were bound to the same evidence pack (audit bbbbbbbb)."))
      .toBeVisible();
    expect(screen.getByText("A regulated market filing was submitted.")).toBeVisible();
    expect(screen.getByText("Bull case")).toBeVisible();
    expect(screen.getByText("78% model argument score")).toBeVisible();
    expect(screen.getByText("42% model argument score")).toBeVisible();
    expect(screen.getByText("Model argument scores are not outcome probabilities.")).toBeVisible();
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

  it("maps the server INVALID_INPUT code to actionable guidance", async () => {
    mockApi(jsonResponse({ error: "INVALID_INPUT" }, 400));
    render(<App />);

    fireEvent.change(screen.getByLabelText("News URL"), {
      target: { value: "https://news.example.org/invalid-input" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review the URL, token, and risk level, then try again.",
    );
  });

  it("turns an analysis network rejection into a stage-specific safe message", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/system") return jsonResponse(system);
      throw new Error("Failed to fetch");
    }));
    render(<App />);

    fireEvent.change(screen.getByLabelText("News URL"), {
      target: { value: "https://news.example.org/network-error" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Analysis request could not reach the service. Check your connection and try again.",
    );
    expect(alert).not.toHaveTextContent("Failed to fetch");
  });

  it("uses ordinary sections on desktop and true tabs after crossing the mobile breakpoint", async () => {
    const viewport = mockViewport(false);
    mockApi();
    const { container } = render(<App />);
    await submitAnalysis();

    expect(screen.queryByRole("tablist", { name: "Analysis views" })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);

    act(() => viewport.setMobile(true));

    const tabs = screen.getByRole("tablist", { name: "Analysis views" });
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(4);
    const claimsTab = within(tabs).getByRole("tab", { name: "Claims" });
    fireEvent.click(claimsTab);

    expect(claimsTab).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: "Decision" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tabpanel", { name: "Claims" })).toBeVisible();

    fireEvent.click(within(tabs).getByRole("tab", { name: "Debate" }));
    const debatePanel = screen.getByRole("tabpanel", { name: "Debate" });
    expect(within(debatePanel).getByText("78% model argument score")).toBeVisible();
    expect(within(debatePanel).getByText("42% model argument score")).toBeVisible();
    expect(within(debatePanel).getByText(
      "Model argument scores are not outcome probabilities.",
    )).toBeVisible();

    act(() => viewport.setMobile(false));
    expect(screen.queryByRole("tablist", { name: "Analysis views" })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
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

  it("shows neutral loading, warning mismatch, and warning network-error replay states", async () => {
    let resolveReplay!: (response: Response) => void;
    const pendingReplay = new Promise<Response>((resolve) => { resolveReplay = resolve; });
    let replayAttempt = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/system") return Promise.resolve(jsonResponse(system));
      if (url === "/api/analyses") return Promise.resolve(jsonResponse(receipt, 201));
      if (url.endsWith("/replay")) {
        replayAttempt += 1;
        if (replayAttempt === 1) return pendingReplay;
        return Promise.reject(new Error("Failed to fetch"));
      }
      return Promise.resolve(jsonResponse({ error: "NOT_FOUND" }, 404));
    }));
    const { container } = render(<App />);
    await submitAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Replay receipt" }));
    expect(await screen.findByText("Replaying receipt")).toBeVisible();
    let replayStatus = container.querySelector(".replay-result");
    expect(replayStatus).toHaveClass("is-loading");
    expect(replayStatus?.querySelector(".lucide-refresh-cw")).toBeInTheDocument();

    resolveReplay(jsonResponse({ id: receipt.id, identical: false, evidenceHash: HASH_A }));
    expect(await screen.findByText("Replay mismatch detected")).toBeVisible();
    replayStatus = container.querySelector(".replay-result");
    expect(replayStatus).toHaveClass("is-error");
    expect(replayStatus?.querySelector(".lucide-triangle-alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Replay receipt" }));
    expect(await screen.findByText(
      "Receipt replay could not reach the service. Check your connection and try again.",
    )).toBeVisible();
    replayStatus = container.querySelector(".replay-result");
    expect(replayStatus).toHaveClass("is-error");
    expect(replayStatus?.querySelector(".lucide-triangle-alert")).toBeInTheDocument();
    expect(replayStatus).not.toHaveTextContent("Failed to fetch");
  });

  it("rejects a replay response for a different receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/system") return jsonResponse(system);
      if (url === "/api/analyses") return jsonResponse(receipt, 201);
      if (url.endsWith("/replay")) {
        return jsonResponse({ id: secondReceipt.id, identical: true, evidenceHash: HASH_A });
      }
      return jsonResponse({ error: "NOT_FOUND" }, 404);
    }));
    render(<App />);
    await submitAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Replay receipt" }));

    expect(await screen.findByText("Receipt replay returned the wrong receipt.")).toBeVisible();
    expect(screen.queryByText("Replay matched stored decision")).not.toBeInTheDocument();
  });

  it("ignores a stale replay completion after a second analysis starts", async () => {
    let resolveReplay!: (response: Response) => void;
    const pendingReplay = new Promise<Response>((resolve) => { resolveReplay = resolve; });
    let analysisCount = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/system") return Promise.resolve(jsonResponse(system));
      if (url === "/api/analyses") {
        analysisCount += 1;
        return Promise.resolve(jsonResponse(analysisCount === 1 ? receipt : secondReceipt, 201));
      }
      if (url === `/api/receipts/${receipt.id}/replay`) return pendingReplay;
      return Promise.resolve(jsonResponse({ error: "NOT_FOUND" }, 404));
    }));
    render(<App />);
    await submitAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Replay receipt" }));
    expect(await screen.findByText("Replaying receipt")).toBeVisible();

    fireEvent.change(screen.getByLabelText("News URL"), {
      target: { value: secondReceipt.input.articleUrl },
    });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));
    expect(await screen.findByText(secondReceipt.id)).toBeVisible();

    await act(async () => {
      resolveReplay(jsonResponse({ id: receipt.id, identical: true, evidenceHash: HASH_A }));
      await pendingReplay;
    });
    expect(screen.queryByText("Replay matched stored decision")).not.toBeInTheDocument();
    expect(screen.getByText("Stored replay verified")).toBeVisible();
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

  it("clears copy feedback when a new receipt replaces the current receipt", async () => {
    let analysisCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/system") return jsonResponse(system);
      if (url === "/api/analyses") {
        analysisCount += 1;
        return jsonResponse(analysisCount === 1 ? receipt : secondReceipt, 201);
      }
      return jsonResponse({ error: "NOT_FOUND" }, 404);
    }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    render(<App />);
    await submitAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Copy receipt ID" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Clipboard unavailable");

    fireEvent.change(screen.getByLabelText("News URL"), {
      target: { value: secondReceipt.input.articleUrl },
    });
    fireEvent.click(screen.getByRole("button", { name: "Analyze evidence" }));
    expect(await screen.findByText(secondReceipt.id)).toBeVisible();
    expect(screen.queryByText(/Clipboard unavailable/)).not.toBeInTheDocument();
  });

  it("resets receipt copy feedback when the panel receives a different receipt id", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const onReplay = vi.fn(async () => undefined);
    const { rerender } = render(
      <ReceiptPanel
        receiptId={receipt.id}
        createdAt={receipt.createdAt}
        storedReplayIdentical
        replayState={{ status: "idle" }}
        onReplay={onReplay}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy receipt ID" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Clipboard unavailable");

    rerender(
      <ReceiptPanel
        receiptId={secondReceipt.id}
        createdAt={secondReceipt.createdAt}
        storedReplayIdentical
        replayState={{ status: "idle" }}
        onReplay={onReplay}
      />,
    );

    expect(screen.queryByText(/Clipboard unavailable/)).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores receipt A clipboard %s after receipt B replaces it",
    async (settlement) => {
      let settleCopy!: () => void;
      const pendingCopy = new Promise<void>((resolve, reject) => {
        settleCopy = () => settlement === "resolve"
          ? resolve()
          : reject(new Error("Clipboard denied"));
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn(() => pendingCopy) },
      });
      const onReplay = vi.fn(async () => undefined);
      const { rerender } = render(
        <ReceiptPanel
          receiptId={receipt.id}
          createdAt={receipt.createdAt}
          storedReplayIdentical
          replayState={{ status: "idle" }}
          onReplay={onReplay}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy receipt ID" }));
      rerender(
        <ReceiptPanel
          receiptId={secondReceipt.id}
          createdAt={secondReceipt.createdAt}
          storedReplayIdentical
          replayState={{ status: "idle" }}
          onReplay={onReplay}
        />,
      );

      await act(async () => {
        settleCopy();
        await Promise.resolve();
      });

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );
});
