import { AlertTriangle, Clock3, Database, ExternalLink } from "lucide-react";

import type { Evidence } from "../../shared/contracts";
import {
  dataModeLabel,
  evidenceStatusLabel,
  formatTimestamp,
} from "../formatters";

function sourceLink(source: string) {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return <a href={source} target="_blank" rel="noreferrer">{source}<ExternalLink aria-hidden="true" size={13} /></a>;
    }
  } catch {
    // RYO tool names and publisher labels are intentionally rendered as text.
  }
  return <strong>{source}</strong>;
}

export function EvidenceExplorer({ evidence }: { evidence: Evidence[] }) {
  return (
    <section aria-labelledby="evidence-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker"><Database aria-hidden="true" size={15} />Provenance</span>
          <h2 id="evidence-title">Evidence</h2>
        </div>
        <span className="count-label">{evidence.length} sources</span>
      </div>
      <div className="evidence-list">
        {evidence.map((item) => (
          <details key={item.id}>
            <summary>
              <span className="evidence-kind">{item.kind.toUpperCase()}</span>
              <span className="evidence-source">{sourceLink(item.source)}</span>
              <span className="evidence-labels">
                <span data-status={item.status}>{evidenceStatusLabel(item.status)}</span>
                <span data-mode={item.dataMode}>{dataModeLabel(item.dataMode)}</span>
              </span>
            </summary>
            <div className="evidence-body">
              <p>{item.summary}</p>
              <dl className="evidence-meta">
                <div><dt><Clock3 aria-hidden="true" size={13} />Retrieved</dt><dd>{formatTimestamp(item.retrievedAt)}</dd></div>
                <div><dt>Observed</dt><dd>{item.observedAt ? formatTimestamp(item.observedAt) : "Not reported"}</dd></div>
                <div><dt>Evidence ID</dt><dd>{item.id}</dd></div>
              </dl>
              {item.warnings.length > 0 && (
                <div className="warning-list">
                  {item.warnings.map((warning) => <p key={warning}><AlertTriangle aria-hidden="true" size={15} />{warning}</p>)}
                </div>
              )}
              <details className="payload-details">
                <summary>Structured payload</summary>
                <pre>{JSON.stringify(item.payload, null, 2)}</pre>
              </details>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
