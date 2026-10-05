# SignalCourt Design

## Product Summary

SignalCourt is an evidence-first crypto news review agent for people who see a
market-moving headline and need to decide whether it supports a practice trade.
It verifies the article's central claims, connects them to live RYO market
evidence, stages a constrained bull-versus-bear debate, and records the final
decision as a replayable receipt.

The product is educational research software. It never places trades, accesses
wallets, or presents its output as financial advice.

## Competition Target

The primary target is the RYO-CHAN Autonomous Agents track. The same BUIDL will
also enter Dashboards & Interfaces because the evidence workspace is a major
part of the product. The implementation must make each track independently
judgeable.

SignalCourt is designed around the published scoring priorities:

- Combine independent news evidence with multiple RYO research tools.
- Show a visible cause-and-effect path from evidence to decision.
- Preserve repeatable reasoning and provenance.
- Keep working honestly when a dependency is unavailable or rate-limited.
- Let a judge understand the important result within 30 seconds.

## User And Decision

The initial user is a non-professional crypto researcher who encounters a viral
headline about a supported token. Their decision is not "what will the market
do?" but "is this claim sufficiently verified and materially supported by the
current market evidence to justify a simulated position?"

The user supplies:

- A public news URL.
- A token symbol.
- A risk level: conservative, balanced, or aggressive.

The system returns one practice decision: `LONG`, `SHORT`, or `NO_TRADE`.

## Core User Flow

1. The user submits a URL, token symbol, and risk level.
2. The system fetches the article and extracts a small set of testable claims.
3. The verifier searches for independent support or contradiction and assigns a
   claim status: verified, disputed, unsupported, or unavailable.
4. The research coordinator calls only the RYO tools relevant to the decision:
   `market_overview`, `analyze_token`, `deep_analysis`, and
   `monitor_market_sentiment_shift`.
5. A bull agent and bear agent receive the same immutable evidence pack. Every
   argument must cite an evidence identifier.
6. A judge applies deterministic evidence and risk gates before considering the
   two arguments.
7. The system records a decision receipt and presents the result in the review
   workspace.
8. Replaying a receipt with its stored evidence reproduces the same decision
   without making fresh network calls.

## Decision Rules

The judge cannot return `LONG` or `SHORT` unless all of these conditions hold:

- At least one central news claim has independent support.
- The RYO response has usable primary market and technical evidence.
- The bull and bear arguments contain valid evidence citations.
- Entry, stop, target, and practice position size can be calculated without
  inventing missing values.

If a gate fails, the result is `NO_TRADE`. Stable reason codes explain why, such
as `CLAIM_UNSUPPORTED`, `MARKET_DATA_UNAVAILABLE`, `CITATION_INVALID`, or
`RISK_INPUT_INCOMPLETE`.

An LLM may extract claims and write evidence-bound arguments. Deterministic code
validates citations, enforces gates, calculates risk values, and creates the
final receipt. The LLM cannot bypass a failed gate.

## Architecture

SignalCourt will use a TypeScript monorepo with three bounded areas:

### Web Client

A React and Vite application renders the review workspace and submits analysis
requests to the server. It never receives the RYO builder key or other private
credentials.

### Application Server

A Node.js server validates inputs, fetches public news, calls Tavily Search and
the RYO REST tools, coordinates agent prompts, validates outputs, and exposes
receipt and replay endpoints.

Agent prompts use one server-side OpenAI-compatible model endpoint configured by
`LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. The application has no hidden
fallback model: missing credentials or a failed model call produces an explicit
unavailable result.

The RYO adapter reads the live catalog at startup, uses structured `data` fields
for decisions, and preserves `status`, `data_mode`, `as_of`, `availability`, and
`warnings` in the evidence pack.

### Receipt Store

SQLite stores immutable evidence packs and decision receipts for the local demo.
Receipts reference evidence by content hash. New analysis creates new records;
existing receipts are never edited in place.

## Data Contracts

An evidence item contains:

- Stable identifier and content hash.
- Source type and source URL or RYO tool name.
- Retrieval timestamp.
- Structured payload.
- Availability and provenance status.
- Human-readable summary that is never used as the sole decision input.

A decision receipt contains:

- Receipt identifier and schema version.
- User inputs and risk profile.
- Evidence hashes and timestamps.
- Claim verdicts.
- Bull and bear arguments with evidence citations.
- Gate results and reason codes.
- Practice decision, confidence, entry, stop, target, and size when available.
- Model name and prompt version.
- Replay verification result.

## Interface Design

The primary screen is a work-focused analysis workspace, not a marketing page.
It has four stable regions:

- Input bar for URL, token, and risk level.
- Claim ledger showing verification status and sources.
- Evidence and debate timeline showing cause and effect.
- Decision receipt showing the verdict, failed gates, risk values, and replay
  status.

Importance controls visual order: the decision and failed gates appear first,
followed by claim status, causal reasoning, and raw evidence. Desktop uses a
dense multi-column layout. Mobile uses tabs for Decision, Claims, Debate, and
Evidence. All core actions are keyboard accessible, and status is never conveyed
by color alone.

## Failure Handling

- Network, `429`, and `503` responses use bounded exponential backoff with
  jitter.
- Fresh RYO results are cached by tool and normalized arguments when appropriate.
- A failed optional source is preserved as unavailable evidence, not replaced
  with a fabricated value.
- Missing central evidence produces `NO_TRADE` instead of a guessed decision.
- A saved receipt remains viewable and replayable when all external services are
  offline.
- User-facing errors identify the failed stage without exposing credentials or
  raw server internals.

## Security And Responsible Use

- `RYO_MCP_KEY`, `TAVILY_API_KEY`, and model credentials remain server-side.
- `.env.example` documents required variables; `.env` is ignored.
- URLs are restricted to HTTP and HTTPS and checked against private and local
  network destinations before server-side fetching.
- Article content and external evidence are treated as untrusted data, never as
  agent instructions.
- Token symbols and risk settings are schema-validated.
- The UI labels all positions as practice decisions and states that SignalCourt
  is not financial advice.

## Testing Strategy

- Unit tests cover validation, claim statuses, evidence hashes, citation checks,
  risk calculations, decision gates, and receipt generation.
- Integration tests use recorded RYO and news fixtures to verify the complete
  analysis pipeline without consuming live quota.
- Failure tests cover rate limits, unavailable data, malformed model output,
  prompt injection in article content, and replay while offline.
- End-to-end tests cover submitting an article, inspecting a decision, and
  replaying its receipt on desktop and mobile layouts.
- A small opt-in live smoke test verifies the authenticated RYO catalog and one
  low-cost tool call without running in the normal test suite.

## Demo Story

The two-minute demo starts with a plausible viral headline. SignalCourt extracts
the central claim, shows one supporting and one contradicting source, connects
the claim to current RYO evidence, and lets the audience watch the opposing
arguments cite the same evidence pack. The judge returns a practice decision and
the presenter immediately replays the receipt offline to prove repeatability.

A second short example removes a required source and demonstrates that the
system returns `NO_TRADE / INSUFFICIENT_EVIDENCE` rather than manufacturing an
answer.

## Scope Boundaries

The first release will not include:

- Real trading, wallets, balances, or transaction signing.
- Social posting or automated public alerts.
- Continuous monitoring of creators or chat channels.
- User accounts, billing, or multi-user collaboration.
- A general-purpose portfolio manager.

These exclusions keep the entry focused on one decision and make its evidence
path easy to judge.

## Acceptance Criteria

The design is implemented when:

- A user can submit a supported article URL, token, and risk profile.
- The system combines independent news evidence with at least two relevant RYO
  tools.
- Every debate claim and final reason references stored evidence.
- Insufficient or unavailable evidence deterministically returns `NO_TRADE`.
- A stored receipt can be replayed offline with an identical decision and reason
  codes.
- The primary workflow works by keyboard and at desktop and mobile viewports.
- Automated tests cover the decision gates and the critical browser workflow.
- No real secret is committed, and the repository includes `.env.example`.
