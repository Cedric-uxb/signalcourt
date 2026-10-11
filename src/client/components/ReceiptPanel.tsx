import { CheckCheck, Copy, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";

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
    | { status: "idle" | "loading" }
    | { status: "success"; result: ReplayResult }
    | { status: "error"; message: string };
  onReplay: () => Promise<void>;
}) {
  const [copyMessage, setCopyMessage] = useState("");

  async function copyId() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(receiptId);
      setCopyMessage("Receipt ID copied.");
    } catch {
      setCopyMessage("Clipboard unavailable. Select the receipt ID to copy it.");
    }
  }

  const replayMessage = replayState.status === "success"
    ? replayState.result.identical
      ? "Replay matched stored decision"
      : "Replay mismatch detected"
    : replayState.status === "error"
      ? replayState.message
      : storedReplayIdentical
        ? "Stored replay verified"
        : "Stored replay mismatch";

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

      <div className={`replay-result ${replayState.status === "error" ? "is-error" : ""}`} aria-live="polite">
        {replayState.status === "success" && !replayState.result.identical
          ? <TriangleAlert aria-hidden="true" size={17} />
          : <CheckCheck aria-hidden="true" size={17} />}
        <span>{replayMessage}</span>
      </div>
      <button
        className="secondary-button"
        type="button"
        disabled={replayState.status === "loading"}
        onClick={() => void onReplay()}
      >
        <RefreshCw aria-hidden="true" size={17} />
        {replayState.status === "loading" ? "Replaying..." : "Replay receipt"}
      </button>
    </section>
  );
}
