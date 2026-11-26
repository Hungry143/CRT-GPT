# CRT INTELLIGENCE — BUILD STAGE 1 / FOUNDATION

**Paste the entire following instruction into Google AI Studio → Build mode as the initial build request.**

You are implementing the first small, verified milestone of an independent, professional **CRT Intelligence** web application. The end product is a market-monitoring, discretionary **signal-only** application — NOT a TradingView Pine indicator, NOT automated trading, and NOT a broker order-execution platform. The project owner is building and reviewing each milestone before advancing.

## Build exactly this milestone, not the entire platform

Create a full-stack app with a **React + TypeScript** frontend and a **Node.js + TypeScript** backend supported by Google AI Studio Build mode. Prefer existing project conventions; use clean components, strict typing, modest dependencies, good accessibility, mobile-responsive layouts, and a polished dark financial-terminal UI. Make the app functional, not a screenshot-only mockup.

**Milestone:** a trustworthy XAUUSD-only *foundation shell*, its diagnostics APIs, and an independent TradingView chart embedded in the web dashboard. Do not implement CRT algorithms or generate trading recommendations yet.

## Non-negotiable safety and data-integrity rules

1. Default to **DATA SOURCE NOT CONNECTED**. Clearly distinguish the TradingView embedded chart (a third-party, self-contained chart display) from a backend market-data connection. A visible TradingView chart does NOT mean the CRT analysis engine has live data.
2. No fake/live-looking quotes, candles, win-rate, P&L, signals, entries, stop losses, targets, confidence percentages, or fabricated timestamps. Render `—`, `No data yet`, or `Not configured`. If optional demonstration fixtures are added, isolate behind an explicit `DEMO DATA` banner and **disable demo mode by default**. Prefer no demo data for stage 1.
3. Never extract/scrape/reverse-engineer data from the TradingView embed or browser. Never use TradingView widget DOM as the backend's price feed. Do not invent an unauthenticated data API.
4. No automatic trading, trade execution, broker account login, order routes, order placement functions, or wallet/payment flows.
5. Do not call the Gemini API for trading decisions. No AI-generated explanations pretending a signal exists. Keys must stay in server environment secrets, never in client bundles or logs.
6. Keep **all event timestamps in UTC ISO-8601**; format user clock in `Asia/Kolkata` and market-reference clock in `America/New_York` using time-zone-aware functions (DST-safe; no fixed -5/-4 assumptions).
7. Feature gates: `MARKET_FEED_ENABLED=false`, `CRT_ENGINE_ENABLED=false`, `SIGNALS_ENABLED=false`. If unset, treat as false. Do not expose toggles that falsely activate unavailable services.
8. The UI must be genuinely responsive and error/empty/loading states must be designed, not filled with fabricated data.

## UI pages / components to build

A. **Command Center** (default route): app identity `CRT Intelligence`, top status bar with Data Feed = Not connected; Engine = Disabled; Signal Mode = Research-only; NY and IST clocks; XAUUSD as the only enabled instrument. A left vertical navigation for Command Center, Instrument Analysis, Signals, Research/Journal, System Health. Later pages can be functional empty states, not fake data.

B. **TradingView Chart section**: embed an official TradingView Advanced Chart *widget* for `OANDA:XAUUSD` if supported, using the documented public embed integration. Use a browser-safe component that loads/unloads without duplicate scripts and doesn't break React strict mode. Label prominently **`TradingView chart display — not engine data feed`**. If embed isn't available, display a graceful fallback with a `Open TradingView` link; never replace it with artificial market candles. Add mobile sizing controls.

C. **Market Status panel**: backend feed state, provider, last valid tick, last valid candle, candle quality. For Stage 1 display Not configured / — for actual market-data fields. Do not assert market-open/closed based on feed availability.

D. **Timeframe panel**: D1, H4, H1, M15 rows, all `Awaiting feed` and no invented bias. M5 shown only as disabled future support. Add informational definitions for HTF and LTF without claiming analysis.

E. **Opportunity Radar**: empty state `No signals — CRT engine not enabled`. Clear visual separation between `forming`, `pending`, and `confirmed` states for future use; do not populate with examples in normal mode.

F. **Research and Journal**: read-only welcome page explaining that CRT source documents are research inputs and source-specific rules will be implemented after validation. Optional simple markdown-style placeholder, with no fake results.

G. **System Health**: API reachability, provider configuration state, engine state, last updated server timestamp, application version, and configuration diagnostics. Provide explicit failure state when API is down.

## Backend API contracts (implement endpoints, not just mock fetch)

`GET /api/health` returns HTTP 200 JSON:
```json
{"service":"crt-intelligence","version":"0.1.0","status":"ok","serverTimeUtc":"<actual server ISO-8601 UTC>"}
```

`GET /api/system/status` returns HTTP 200 JSON where `serverTimeUtc` is the real server time and all other Stage 1 values reflect actual unconfigured state:
```json
{
  "schemaVersion":"1.0.0",
  "environment":"development",
  "serverTimeUtc":"<actual server ISO-8601 UTC>",
  "marketFeed":{"state":"NOT_CONFIGURED","provider":null,"symbol":null,"lastTickAtUtc":null,"lastClosedBarAtUtc":null,"quality":"UNAVAILABLE"},
  "crtEngine":{"state":"DISABLED","ruleVersion":null},
  "signalService":{"state":"DISABLED","confirmedSignals":0},
  "riskMode":"RESEARCH_ONLY",
  "orderExecutionEnabled":false
}
```

`GET /api/instruments` returns exactly one **configuration-only** instrument with key `XAUUSD`, `enabled:true`, `marketDataConnected:false`, and no price or derived quote. The chart symbol `OANDA:XAUUSD` is a display choice, not an assertion of the future backend feed identifier.

`GET /api/signals` returns `{"data":[],"state":"ENGINE_DISABLED"}` for Stage 1.

Use a shared typed API contract / Zod schema if the selected stack supports it. Validate payloads and encode `no data` as `null`, never as an invented zero.

## Architecture / extensibility

Create a clean project structure with separate `client/components`, `client/pages`, `client/services`, `server/routes`, `shared/contracts`, and `tests` (adapt paths to the environment, but keep boundaries). Shared type definitions should include `FeedState`, `EngineState`, `SignalState`, `Candle` (future only), `RuleEvidence` (future only), `Signal` (future only), and `InstrumentConfig`. Do not implement CRT engine logic in the frontend. TradingView integration must be isolated behind a component so chart provider can be replaced later.

Document the intent to add `MarketDataAdapter`, `CandleBuilder`, `SessionClock`, `SourceRuleRegistry`, `CRTDetector`, `RiskCalculator`, `SignalStateMachine`, `ReplayBacktester`, but **do not implement fake algorithms** in this milestone.

## Tests and completion

Implement automated tests supported by this project setup. At minimum:
- `/api/health` responds correctly with a parseable real UTC timestamp.
- `/api/system/status` defaults to `NOT_CONFIGURED` / `DISABLED` / `RESEARCH_ONLY` / `orderExecutionEnabled=false`.
- `/api/signals` returns an empty array.
- `null` provider tick/bar means no price, no inferred market bias and no confirmed signals shown.
- The time formatter correctly changes New York offset between winter and summer dates.
- Chart embed mount/unmount handles failures without taking down the dashboard.
- No server secrets are imported by frontend code; there are no broker-trading endpoints.

Run build/typecheck/tests using whatever commands are supported. If any fail, repair then rerun. **Do not claim tests passed unless you actually executed them and report the commands/results.** If testing cannot run in AI Studio, say exactly which checks were not executed, rather than inventing success.

## Stop condition

Finish **Stage 1 only**. In your final output list actual files created, implemented routes, test results, known limitations, and the next engineering gate. Do NOT proceed automatically to market-data provider integration, signal detection, authentication complexity, Gemini signal generation, payments, or live publishing.
