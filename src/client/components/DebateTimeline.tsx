import { ArrowDown, TrendingDown, TrendingUp } from "lucide-react";

import type { Argument } from "../../shared/contracts";

export function DebateTimeline({ arguments: sides }: { arguments: [Argument, Argument] }) {
  return (
    <section aria-labelledby="debate-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker">Same evidence pack</span>
          <h2 id="debate-title">Evidence debate</h2>
        </div>
      </div>
      <p className="debate-score-note">Model argument scores are not outcome probabilities.</p>
      <div className="debate-timeline">
        {sides.map((side, index) => {
          const Icon = side.stance === "bull" ? TrendingUp : TrendingDown;
          const score = Math.round(side.confidence * 100);
          return (
            <article key={side.stance} data-stance={side.stance}>
              <div className="debate-heading">
                <span><Icon aria-hidden="true" size={17} />{side.stance === "bull" ? "Bull case" : "Bear case"}</span>
                <strong>{score}% model argument score</strong>
              </div>
              <p>{side.thesis}</p>
              <div className="citation-tags" aria-label={`${side.stance} citations`}>
                {side.citations.map((citation) => <span key={citation}>{citation}</span>)}
              </div>
              {index === 0 && <ArrowDown className="debate-flow" aria-hidden="true" size={17} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}
