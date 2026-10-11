import { CheckCheck, Copy, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { ReplayResult } from "../api";
import { formatTimestamp } from "../formatters";

export function ReceiptPanel({
  receiptId,
  createdAt,
  storedReplayIdentical,
  replayState,
  onReplay,
}: {
  receiptId: string;
  createdAt: string;
  storedReplayIdentical: boolean;
  replayState:
    | { status: "idle" }
    | { status: "loading"; receiptId: string }
    | { status: "success"; receiptId: string; result: ReplayResult }
    | { status: "error"; receiptId: string; message: string };
  onReplay: () => Promise<void>;
}) {
  const [copyMessage, setCopyMessage] = useState("");

  useEffect(() => {
    setCopyMessage("");
  }, [receiptId]);

  async function copyId() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(receiptId);
      setCopyMessage("Receipt ID copied.");
    } catch {
      setCopyMessage("Clipboard unavailable. Select the receipt ID to copy it.");
    }
  }

  const visibleReplayState = replayState.status !== "idle" && replayState.receiptId !== receiptId
    ? { status: "idle" as const }
    : replayState;
  const replayView = visibleReplayState.status === "loading"
    ? {
        className: "is-loading",
        icon: <RefreshCw aria-hidden="true" className="spin-icon" size={17} />,
        message: "Replaying receipt",
      }
    : visibleReplayState.status === "error"
      ? {
          className: "is-error",
          icon: <TriangleAlert aria-hidden="true" size={17} />,
          message: visibleReplayState.message,
        }
      : visibleReplayState.status === "success" && !visibleReplayState.result.identical
        ? {
            className: "is-error",
            icon: <TriangleAlert aria-hidden="true" size={17} />,
            message: "Replay mismatch detected",
          }
        : visibleReplayState.status === "success"
          ? {
              className: "is-success",
              icon: <CheckCheck aria-hidden="true" size={17} />,
              message: "Replay matched stored decision",
            }
          : storedReplayIdentical
            ? {
                className: "is-success",
                icon: <CheckCheck aria-hidden="true" size={17} />,
                message: "Stored replay verified",
              }
            : {
                className: "is-error",
                icon: <TriangleAlert aria-hidden="true" size={17} />,
                message: "Stored replay mismatch",
              };

  return (
    <section className="receipt-panel" aria-labelledby="receipt-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker"><ShieldCheck aria-hidden="true" size={15} />Audit trail</span>
          <h2 id="receipt-title">Decision receipt</h2>
        </div>
      </div>
      <div className="receipt-id-row">
        <code tabIndex={0}>{receiptId}</code>
        <button className="icon-button" type="button" title="Copy receipt ID" aria-label="Copy receipt ID" onClick={() => void copyId()}>
          <Copy aria-hidden="true" size={17} />
        </button>
      </div>
      {copyMessage && <p className="copy-feedback" role="status">{copyMessage}</p>}
      <time dateTime={createdAt}>Created {formatTimestamp(createdAt)}</time>

      <div
        className={`replay-result ${replayView.className}`}
        aria-live="polite"
        role={replayView.className === "is-error" ? "alert" : undefined}
      >
        {replayView.icon}
        <span>{replayView.message}</span>
      </div>
      <button
        className="secondary-button"
        type="button"
        disabled={visibleReplayState.status === "loading"}
        onClick={() => void onReplay()}
      >
        <RefreshCw aria-hidden="true" size={17} />
        {visibleReplayState.status === "loading" ? "Replaying..." : "Replay receipt"}
      </button>
    </section>
  );
}
