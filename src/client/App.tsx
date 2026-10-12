import { Activity, AlertTriangle, FlaskConical } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AnalysisRequest, Receipt } from "../shared/contracts";
import {
  createAnalysis,
  getSystemStatus,
  replayReceipt,
  type ReplayResult,
  type SystemStatus,
} from "./api";
import { AnalysisForm } from "./components/AnalysisForm";
import { ClaimLedger } from "./components/ClaimLedger";
import { DebateTimeline } from "./components/DebateTimeline";
import { DecisionSummary } from "./components/DecisionSummary";
import { EvidenceExplorer } from "./components/EvidenceExplorer";
import { ReceiptPanel } from "./components/ReceiptPanel";
import { WorkspaceTabs, type WorkspaceTab } from "./components/WorkspaceTabs";
import { useMediaQuery } from "./useMediaQuery";

type AppState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; receipt: Receipt }
  | { status: "error"; message: string };

type ReplayState =
  | { status: "idle" }
  | { status: "loading"; receiptId: string }
  | { status: "success"; receiptId: string; result: ReplayResult }
  | { status: "error"; receiptId: string; message: string };

export function App() {
  const [state, setState] = useState<AppState>({ status: "idle" });
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("decision");
  const [replayState, setReplayState] = useState<ReplayState>({ status: "idle" });
  const isMobile = useMediaQuery("(max-width: 820px)");
  const replayRequest = useRef(0);
  const activeReceiptId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSystemStatus()
      .then((status) => { if (active) setSystem(status); })
      .catch(() => { if (active) setSystem(null); });
    return () => { active = false; };
  }, []);

  async function analyze(input: AnalysisRequest) {
    replayRequest.current += 1;
    activeReceiptId.current = null;
    setState({ status: "loading" });
    setReplayState({ status: "idle" });
    try {
      const receipt = await createAnalysis(input);
      activeReceiptId.current = receipt.id;
      setState({ status: "success", receipt });
      setActiveTab("decision");
    } catch (error) {
      activeReceiptId.current = null;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Analysis unavailable.",
      });
    }
  }

  const receipt = state.status === "success" ? state.receipt : null;

  async function runReplay() {
    if (!receipt) return;
    const receiptId = receipt.id;
    const requestId = ++replayRequest.current;
    setReplayState({ status: "loading", receiptId });
    try {
      const result = await replayReceipt(receiptId);
      if (requestId !== replayRequest.current || activeReceiptId.current !== receiptId) return;
      setReplayState({ status: "success", receiptId, result });
    } catch (error) {
      if (requestId !== replayRequest.current || activeReceiptId.current !== receiptId) return;
      setReplayState({
        status: "error",
        receiptId,
        message: error instanceof Error ? error.message : "Receipt replay unavailable.",
      });
    }
  }

  function mobilePanelProps(tab: WorkspaceTab) {
    if (!isMobile) return {};
    return {
      id: `view-${tab}`,
      role: "tabpanel" as const,
      "aria-labelledby": `tab-${tab}`,
      hidden: activeTab !== tab,
    };
  }

  return (
    <main className="workspace">
      <header className="app-header">
        <div className="brand-block">
          <span className="eyebrow">Evidence-first market review</span>
          <h1>SignalCourt</h1>
        </div>
        <div className="header-status">
          <span className="system-badge" data-mode={system?.mode ?? "unknown"}>
            <Activity aria-hidden="true" size={15} />
            {system ? `${system.mode === "demo" ? "Demo" : "Live"} mode` : "Checking system"}
          </span>
          <span className="practice-label"><FlaskConical aria-hidden="true" size={15} />Practice only</span>
        </div>
      </header>

      <div className="responsible-banner">
        <AlertTriangle aria-hidden="true" size={16} />
        <p>SignalCourt is for evidence review and simulated practice only. It is not financial advice.</p>
      </div>

      <AnalysisForm loading={state.status === "loading"} onSubmit={analyze} />
      {receipt && isMobile && <WorkspaceTabs active={activeTab} onChange={setActiveTab} />}

      <div className={`analysis-grid ${receipt ? "has-receipt" : "is-empty"}`}>
        <div className="primary-column">
          {receipt ? (
            <>
              <div
                {...mobilePanelProps("decision")}
                className={`panel tab-decision ${activeTab === "decision" ? "is-active" : ""}`}
              >
                <DecisionSummary {...receipt} />
              </div>
              <div
                {...mobilePanelProps("claims")}
                className={`panel tab-claims ${activeTab === "claims" ? "is-active" : ""}`}
              >
                <ClaimLedger claims={receipt.claims} />
              </div>
              <div
                {...mobilePanelProps("debate")}
                className={`panel tab-debate ${activeTab === "debate" ? "is-active" : ""}`}
              >
                <DebateTimeline arguments={receipt.arguments} />
              </div>
            </>
          ) : (
            <section className="empty-state" aria-labelledby="pending-title">
              <span className="empty-marker">01</span>
              <div>
                <span className="section-kicker">{state.status === "loading" ? "Collecting sources" : "Awaiting input"}</span>
                <h2 id="pending-title">{state.status === "loading" ? "Analysis in progress" : "Decision pending"}</h2>
                <p role={state.status === "loading" ? "status" : undefined}>
                  {state.status === "loading"
                    ? "Verifying claims and assembling the evidence pack."
                    : "Submit a public news URL to build an auditable evidence pack and practice decision."}
                </p>
                {state.status === "error" && <p className="analysis-error" role="alert">{state.message}</p>}
              </div>
            </section>
          )}
        </div>

        <aside className="secondary-column" aria-label="Evidence and receipt">
          {receipt ? (
            <>
              <div
                className={`panel tab-decision ${activeTab === "decision" ? "is-active" : ""}`}
                hidden={isMobile && activeTab !== "decision"}
              >
                <ReceiptPanel
                  receiptId={receipt.id}
                  createdAt={receipt.createdAt}
                  storedReplayIdentical={receipt.replay.identical}
                  replayState={replayState}
                  onReplay={runReplay}
                />
              </div>
              <div
                {...mobilePanelProps("evidence")}
                className={`panel tab-evidence ${activeTab === "evidence" ? "is-active" : ""}`}
              >
                <EvidenceExplorer evidence={receipt.evidence} />
              </div>
            </>
          ) : (
            <section className="evidence-empty" aria-labelledby="evidence-empty-title">
              <span className="empty-marker">02</span>
              <div>
                <span className="section-kicker">Provenance</span>
                <h2 id="evidence-empty-title">{state.status === "loading" ? "Collecting evidence" : "Evidence queue"}</h2>
                <p>{state.status === "loading"
                  ? "Checking source availability, timestamps, and evidence modes."
                  : "Sources, availability, timestamps, warnings, and raw payloads will appear here."}</p>
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
