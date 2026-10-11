import { AlertTriangle, CircleCheck, GitBranch, Scale } from "lucide-react";

import type { Receipt } from "../../shared/contracts";
import { causalStepLabel, formatMoney, reasonLabel } from "../formatters";

type Props = Pick<
  Receipt,
  "verdict" | "confidence" | "reasonCodes" | "causalChain" | "riskPlan"
>;

export function DecisionSummary({
  verdict,
  confidence,
  reasonCodes,
  causalChain,
  riskPlan,
}: Props) {
  const VerdictIcon = verdict === "NO_TRADE" ? AlertTriangle : CircleCheck;

  return (
    <section className="decision-section" aria-labelledby="decision-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker"><Scale aria-hidden="true" size={15} />Decision</span>
          <h2 id="decision-title"><VerdictIcon aria-hidden="true" size={26} />{verdict}</h2>
        </div>
        <div className="score-summary">
          <span className="confidence-value">{Math.round(confidence * 100)}% Model debate score</span>
          <span className="score-note">This score is not an outcome probability.</span>
        </div>
      </div>
      <p className="practice-callout">Practice decision only. Not a trade instruction.</p>

      <div className="decision-block">
        <h3>Gate results</h3>
        {reasonCodes.length > 0 ? (
          <ul className="reason-list">
            {reasonCodes.map((code) => <li key={code}>{reasonLabel(code)}</li>)}
          </ul>
        ) : (
          <p className="quiet-copy">No blocking reason codes were recorded.</p>
        )}
      </div>

      {riskPlan ? (
        <dl className="risk-grid">
          <div><dt>Entry</dt><dd>{formatMoney(riskPlan.entry)}</dd></div>
          <div><dt>Stop</dt><dd>{formatMoney(riskPlan.stop)}</dd></div>
          <div><dt>Target</dt><dd>{formatMoney(riskPlan.target)}</dd></div>
          <div><dt>Practice size</dt><dd>{formatMoney(riskPlan.practiceSizeUsd)}</dd></div>
        </dl>
      ) : (
        <p className="no-position"><AlertTriangle aria-hidden="true" size={17} />No practice position was created.</p>
      )}

      <div className="causal-chain" aria-labelledby="causal-title">
        <h3 id="causal-title"><GitBranch aria-hidden="true" size={16} />Why this decision</h3>
        <ol>
          {causalChain.map((step, index) => (
            <li key={`${index}-${step}`}><span>{index + 1}</span><p>{causalStepLabel(step)}</p></li>
          ))}
        </ol>
      </div>
    </section>
  );
}
