# CRT Intelligence — Whole-System Product Contract

**Product:** multi-instrument, signal-only CRT trading intelligence terminal. This document replaces the single-XAUUSD research-shell mindset. Build one integrated product, not many disconnected prototype stages. Do not claim completion until the end-to-end acceptance gate is met.

## Fixed trading universe (14)

EURUSD, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURGBP, EURJPY, GBPJPY, AUDJPY, EURCHF, XAUUSD, XAGUSD. Every module—feed, candle store, watchlist, structure, CRT engine, signal, lifecycle, journal, analytics—must be instrument-keyed, not hardcoded to XAUUSD. One instrument can be unavailable without silently suppressing or contaminating the others.

## Non-negotiable product behavior

- **Signal-only.** No broker-order execution; no broker positions or trades endpoints. Manual trader decision only. Never fabricate prices, timestamps, signals, outcomes, win rates or backtests.
- **Verified data boundary.** TradingView widget is visualization only; never scrape its DOM. Broker/vendor API OHLC must be independently authorized and provenance-tagged. Account/region restrictions are hard errors, not bypass triggers. Integrate multiple licensed provider adapters when needed, not OANDA-only.
- **Closed bars, deterministic rules.** H4 -> H1 -> M15 with D1 context, optional M5 in later entries. NY/DST-aware H4/D1 alignment. No lookahead, no synthetic gap filling. Detect feed staleness, spread/time/source divergence and provider access failures.
- **CRT profile gate.** Only Expansion and Reversal profiles allowed to proceed. Ranging, Manipulation and Retracement are non-trading states.
- **CRT inputs.** PDH/PDL, PWH/PWL, PMH/PML, EQH/EQL, confirmed swing structure, BOS (body-close vs wick sweep), CSD, dealing range and premium/discount, dual DOL, FVG, OB and Breaker, session timing. Entry models: OB, FVG, Turtle Soup, Kiss of Death.
- **Evidence-driven G0–G7 gates.** Require complete source-versioned rule evidence; 100-point score is informative only and cannot bypass a failed gate. Minimum net RR 2.0 after costs; risk preference default 0.5%, user configurable. Before rules are derived from reviewed CRT sources, rules are UNVERIFIED and the engine must emit no confirmed signals.
- **Lifecycle.** Forming -> awaiting confirmation -> confirmed -> invalidated / expired / entry triggered -> TP1 / TP2 / SL / closed, with timestamped event journal and bid/ask-aware observations. One-hour default validity window is configurable and separate from technical invalidation. No hindsight rewriting.
- **Decision UI.** 14-pair status watchlist, selected TradingView chart, D1/H4/H1/M15 context, forming/confirmed signals, entry SL TP1 TP2 RR grade/rule evidence, freshness/source status, timestamps in UTC/NY/IST, journal, performance with sample size and explicit unavailable states.
- **History/replay.** Versioned data snapshots, no-lookahead deterministic bar replay, unit/integration/regression tests, by-instrument and by-CRT-mode performance, loss/outcome attribution, bias/coverage audit. Demo and replay artifacts never appear as live signals.

## Architecture

Next.js React UI -> read-only instrument-scoped APIs -> provider-agnostic market-data gateway -> normalized candles + read-only quality metadata -> deterministic structure/CRT engine -> G0–G7 purity gates -> signal ledger -> lifecycle observer -> journal & analytics. PostgreSQL maintains source/account/instrument isolation; one bounded ingestion worker runs outside Next.js request handlers. TradingView is visually independent.

Current OANDA code remains as one optional provider adapter; it is not the system's identity or a prerequisite to complete the multi-asset platform. An inaccessible provider marks its instruments UNAVAILABLE, not the system COMPLETED.

## Acceptance gate — full working system

1. All 14 instruments show correct independent state, switching charts and API queries.
2. Every instrument has verified data or explicit NO_PROVIDER/UNAVAILABLE reason. No fabricated quotes.
3. H4/H1/M15 and D1 bars pass session alignment, gap, staleness, provenance tests, including NY DST.
4. Source-versioned CRT rules are implemented, replay-tested and matched to reference examples. Unknown rules fail closed.
5. Deterministic G0–G7 produce auditable signals where legitimate; zero false signals when gates fail.
6. A legitimate confirmed signal has valid entry, SL, TP1, TP2, net RR, expiry, grade, evidence and no execution ability.
7. Live lifecycle updates, persistent journal and honest analytics survive restart and provider outages.
8. Independent unit/integration/CI tests, production build, degraded-mode and read-only security checks pass.
9. Stage 1 chart and diagnostics behavior preserved; no invented live status.
10. Operator runbook covers provider entitlements, secrets, database, worker, monitoring and recovery.

## Delivery policy

Work on `feature/full-crt-14-market-system`, not directly on `main`. Submit functional integration units with tests and honest completion status. Never hide missing market-data entitlements or missing CRT source specifications behind a green dashboard. Stop expanding diagnostics unrelated to the system unless security-critical. No production live-trade readiness claim.
