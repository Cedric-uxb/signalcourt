import { CircleAlert, CircleCheck, CircleHelp, Link2 } from "lucide-react";

import type { Claim } from "../../shared/contracts";
import { claimStatusLabel } from "../formatters";

export function ClaimLedger({ claims }: { claims: Claim[] }) {
  return (
    <section aria-labelledby="claims-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker">Verification</span>
          <h2 id="claims-title">Claim ledger</h2>
        </div>
        <span className="count-label">{claims.length} {claims.length === 1 ? "claim" : "claims"}</span>
      </div>
      <ul className="ledger">
        {claims.map((claim) => {
          const Icon = claim.status === "verified"
            ? CircleCheck
            : claim.status === "disputed"
              ? CircleAlert
              : CircleHelp;
          return (
            <li key={claim.id} data-status={claim.status}>
              <Icon aria-hidden="true" size={19} />
              <div>
                <div className="ledger-line">
                  <strong>{claim.text}</strong>
                  <span className="status-label">{claimStatusLabel(claim.status)}</span>
                </div>
                <p>{claim.explanation}</p>
                <span className="citation-line"><Link2 aria-hidden="true" size={13} />Evidence: {claim.evidenceIds.length > 0 ? claim.evidenceIds.join(", ") : "None cited"}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
