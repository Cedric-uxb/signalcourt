import { SearchCheck } from "lucide-react";
import { useRef, useState } from "react";

import type { AnalysisRequest } from "../../shared/contracts";

type FieldErrors = Partial<Record<"articleUrl" | "tokenSymbol", string>>;

function validate(articleUrl: string, token: string): FieldErrors {
  const errors: FieldErrors = {};
  try {
    const url = new URL(articleUrl);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new Error();
  } catch {
    errors.articleUrl = "Enter a public HTTP(S) news URL.";
  }
  if (!/^[A-Z0-9]{2,12}$/.test(token.trim().toUpperCase())) {
    errors.tokenSymbol = "Use 2-12 letters or numbers.";
  }
  return errors;
}

export function AnalysisForm({
  loading,
  onSubmit,
}: {
  loading: boolean;
  onSubmit: (input: AnalysisRequest) => Promise<void>;
}) {
  const [articleUrl, setArticleUrl] = useState("");
  const [token, setToken] = useState("SOL");
  const [riskLevel, setRiskLevel] = useState<AnalysisRequest["riskLevel"]>("balanced");
  const [errors, setErrors] = useState<FieldErrors>({});
  const articleUrlRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const errorSummary = Object.values(errors).filter((message): message is string => Boolean(message));

  return (
    <form
      className="analysis-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const nextErrors = validate(articleUrl, token);
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) {
          if (nextErrors.articleUrl) articleUrlRef.current?.focus();
          else tokenRef.current?.focus();
          return;
        }
        void onSubmit({ articleUrl: articleUrl.trim(), token: token.trim().toUpperCase(), riskLevel });
      }}
    >
      <div className="field-group field-url">
        <label htmlFor="article-url">News URL</label>
        <input
          ref={articleUrlRef}
          id="article-url"
          type="url"
          value={articleUrl}
          placeholder="https://publisher.com/article"
          aria-invalid={Boolean(errors.articleUrl)}
          aria-describedby={errors.articleUrl ? "article-url-error" : "article-url-hint"}
          onChange={(event) => {
            setArticleUrl(event.target.value);
            if (errors.articleUrl) setErrors((current) => ({ ...current, articleUrl: undefined }));
          }}
        />
        <span className="field-hint" id="article-url-hint">Public news or filing URL</span>
        {errors.articleUrl && <span className="field-error" id="article-url-error">{errors.articleUrl}</span>}
      </div>

      <div className="field-group field-token">
        <label htmlFor="token-symbol">Token symbol</label>
        <input
          ref={tokenRef}
          id="token-symbol"
          value={token}
          inputMode="text"
          autoCapitalize="characters"
          maxLength={12}
          aria-invalid={Boolean(errors.tokenSymbol)}
          aria-describedby={errors.tokenSymbol ? "token-error" : "token-hint"}
          onChange={(event) => {
            setToken(event.target.value.toUpperCase());
            if (errors.tokenSymbol) {
              setErrors((current) => ({ ...current, tokenSymbol: undefined }));
            }
          }}
        />
        <span className="field-hint" id="token-hint">2-12 letters or numbers</span>
        {errors.tokenSymbol && <span className="field-error" id="token-error">{errors.tokenSymbol}</span>}
      </div>

      <fieldset className="risk-field">
        <legend>Risk level</legend>
        <div className="segments">
          {(["conservative", "balanced", "aggressive"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="risk"
                value={value}
                checked={riskLevel === value}
                onChange={() => setRiskLevel(value)}
              />
              <span>{value.charAt(0).toUpperCase() + value.slice(1)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <button className="analyze-button" disabled={loading} aria-busy={loading}>
        <SearchCheck aria-hidden="true" size={18} />
        {loading ? "Analyzing evidence..." : "Analyze evidence"}
      </button>

      {errorSummary.length > 0 && (
        <p className="form-error-summary" role="alert" aria-live="assertive">
          {errorSummary.join(" ")}
        </p>
      )}
    </form>
  );
}
