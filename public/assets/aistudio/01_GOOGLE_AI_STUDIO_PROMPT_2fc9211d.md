# CRT Intelligence — Stage 2A Build Prompt

**Paste this entire specification into the EXISTING CRT Intelligence project in Google AI Studio Build mode. DO NOT create a second app.**

## Objective

Implement **Stage 2A: read-only market-data contracts, configurable provider-adapter skeleton, DST-safe session clock, auditable candle validation and fixture-based tests** in the current Next.js + React + TypeScript application.

Keep the Stage 1 frontend, layout, chart and routes intact. Stage 2A must work and pass tests with **ZERO third-party credentials**. No live-feed connected badge until a genuine authenticated provider successfully returns fresh data. No signals, no CRT analysis, no position sizing, no trade execution or broker actions.

## First inspect and preserve the current repo

Before modifying code, inspect:
- `shared/contracts/api.ts`, `shared/utils/time.ts`, `shared/utils/display.ts`, `shared/architecture.ts`
- `server/config/featureGates.ts`
- the four current `/api/*` handlers and routes
- `client/services/apiClient.ts`, the existing views, and all current tests.

Extend the existing schemas and patterns rather than replacing them. Existing four Stage 1 endpoints must retain their valid response shape and semantics. Preserve `OANDA:XAUUSD` as an **independent third-party chart widget**; never represent its displayed prices as our backend's market feed. Keep `CRT_ENGINE_ENABLED=false`, `SIGNALS_ENABLED=false`, `orderExecutionEnabled=false` as enforced SERVER-SIDE invariants. **Do not implement `/orders`, `/trades`, or other trade-execution paths.**

## A. Market-data adapter contract

Create a `MarketDataAdapter` interface and `NoProviderAdapter` implementation. Add an `OandaV20MarketDataAdapter` behind a server-only configuration gate, without requiring credentials for installation/build/tests. This adapter may call **only explicitly allowlisted, read-only** market data and account-instrument lookup endpoints. Never import any order, trade, or position API client.

- `NoProviderAdapter`: returns `NOT_CONFIGURED` and empty data, never mock prices.
- `OandaV20MarketDataAdapter`: requires `OANDA_ENV` (`practice` or `live`), `OANDA_ACCOUNT_ID`, `OANDA_API_TOKEN`, and an explicitly configured instrument, all from server-only secrets; use a hardcoded allowlist of OANDA hostnames, TLS, request timeout, retry with jitter on 429/5xx, bounded requests, and careful error redaction. No credentials => NOT_CONFIGURED. Authentication failure => AUTH_ERROR, disabled. Request of unknown instrument => INSTRUMENT_UNAVAILABLE, disabled. Feed disconnect => STALE/ERROR and engine remains disabled. Do NOT claim `XAU_USD` is supported until account instruments verify it.
- For initial exploration the suggested candidate symbol is `XAU_USD`, but it must be discovered/verified against the user's eligible account. `OANDA:XAUUSD` on TradingView is NOT proof of access to that account's API feed.
- A provider API token may grant trading privileges. Protect it as a privileged secret even though our application calls market-data endpoints only. It must never be displayed, logged, or sent to the browser.
- Define and test one provider-neutral normalization step. Do not make the UI or CRT engine dependent on the raw OANDA response format.

## B. Canonical data contracts

Zod schemas and TypeScript types for:

1. `MarketDataProviderState`: `NOT_CONFIGURED | CONNECTING | CONNECTED | STALE | AUTH_ERROR | INSTRUMENT_UNAVAILABLE | ERROR | MARKET_CLOSED` (use explicit quality and state, not fabricated quotes).
2. `ProviderInstrument`: `displaySymbol`, `providerName`, `providerSymbol`, `pricePrecision`, `pipLocation` where verified, `minTradeSize` optional and not needed at Stage 2A; unknown fields `null`.
3. `NormalizedCandle`: `provider`, `providerSymbol`, `granularity`, `priceBasis` (`MID|BID|ASK`), `openTimeUtc`, `closeTimeUtc`, `open`, `high`, `low`, `close` stored as validated decimal strings, optional `volume`, `complete`, `sourceRetrievedAtUtc`, `sourceCandleId` or deterministic bar key. Expose only *completed* candles from public completed-candle API. `volume` is provider tick/price count, not automatically exchange traded volume.
4. `FeedQuality`: `state`, `lastSuccessfulRequestUtc`, `lastProviderCandleOpenUtc`, `lastCompleteCandleCloseUtc`, `freshnessSeconds`, `missingBarCount`, `duplicateBarCount`, `alignmentPolicy`, `warnings`, `reasonCode`. Unknown values `null` rather than `0`.
5. `SessionClock`: IANA timezone `America/New_York`, user display timezone `Asia/Kolkata`, UTC storage; versions of session policy and daily roll anchor. No browser timezone used to anchor candles.

Required validation: strict positive price values; high >= max(open,close,low); low <= min(open,close,high); valid chronologically ordered UTC instants; no duplicate `(provider,symbol,priceBasis,granularity,openTimeUtc)`; stable interval lengths according to the *selected* provider session policy, with DST-aware daily/H4 behavior; late/incomplete candles must never be published as finalized.

## C. Timeframe policy — be explicit

Research setup: display `D1,H4,H1,M15`; plan to retain `M1` historical data for later replay/intrabar event ordering and add `M5` in later stage. **Do not assume fixed UTC H4 boundaries.**

For OANDA v20 candidate, request `smooth=false`, `price=M` for research candles, and specify `dailyAlignment=17`, `alignmentTimezone=America/New_York` where daily-aligned candle granularities support it. Default `weeklyAlignment=Friday` only if provider doc confirms and chosen policy agrees. H4 anchored to 17:00 NY yields NY local opens 17:00,21:00,01:00,05:00,09:00,13:00, matching some studied 1/5/9 time models; confirm with returned provider timestamps. Distinguish source strategy's NY-local hours from display IST clocks and from source documents with *unspecified* timezone. **A candle's price 50% midpoint and elapsed-time 50% midpoint are separate values.**

A provider closed bar is final only if its `complete` flag is true AND bar-end integrity checks pass; allow a configurable publication grace period. Do not infer a completed D1/H4 candle from local system time alone. Handle weekends/market holidays as expected market closures instead of false missing-data alerts, using verified market schedule or explicit UNKNOWN state.

## D. History and reliability

Build a `CandleValidator`, `SessionClock`, `CandleStore` interface, `InMemoryCandleStore` for deterministic unit tests, and an optional **persistent** PostgreSQL store behind explicit environment configuration. Do not store production data in Next.js temporary container filesystem or in browser local storage. If no persistent database configured, show `History: NOT_PERSISTENT` and do not claim long-term history is retained.

Initial backfill service should be **disabled by default**; when enabled with verified provider config, page through source history in bounded batches (OANDA maximum 5000 candles per request), deduplicate and upsert idempotently. `includeFirst`/cursor boundaries must not lose or duplicate candles. Reconcile backfill with incremental updates and flag unexpected candle changes as source revisions. Implement max request age, cancellation and bounded retry. Do not spin an always-running job from a Next.js serverless request: provide a separate worker or scheduler interface, and explain the deployment requirement.

## E. Endpoints and UI

Preserve all existing 4 APIs. Add:
- `GET /api/market/status` — safe public provider state/quality; never secrets.
- `GET /api/market/candles?instrument=XAUUSD&granularity=M15&limit=100` — validated completed-bar DTO, empty `[]` with status `NOT_CONFIGURED` if no feed; allow only `XAUUSD` and enumerated resolutions, hard max page size.
- `GET /api/market/session` — now UTC, NY local time with DST offset, IST display time, chosen anchor policy, computed next boundary; distinguish expected session vs observed market availability.

Update `System Health` and a small `Data Integrity` panel with **feed adapter status, provider verified yes/no, last completed candle time, freshness, bar gap/duplicate counters, session/DST status, historical persistence status**. Default all financial figures to em dash/`null`. Keep TradingView widget visibly labeled independent third-party chart. Don't add buy/sell signal components or prices from fixtures to the main command center.

For development only, make *clearly labeled* synthetic fixtures available to test runner/test storybook, never reachable in live production endpoints. If any display uses fixtures in a dedicated test view, add permanent `SYNTHETIC TEST DATA — NOT LIVE / NO SIGNAL` watermark.

## F. Mandatory tests

1. Stage 1 original test suite remains green (API schemas, no data -> no signals, clock differences, chart lifecycle, secret checks).
2. No API credentials case: `market/status=NOT_CONFIGURED`, `market/candles=[]`, existing `confirmedSignals=0`, CRT and signals DISABLED.
3. Simulated valid closed candles: serialized correctly, strictly ordered, no lookahead, no client widget as input.
4. Reject malformed OHLC, missing timestamp, incomplete candle, duplicate timestamp, reversed time, invalid symbol/timeframe, oversized limit.
5. Retry and feed outage: no fabricated new bars, stale indicator, no engine activation.
6. DST boundaries `America/New_York` March and November transitions (including Nov 2026) and IST constant UTC+05:30. H4 local anchors stay 1/5/9/13/17/21 if selected 17NY policy.
7. Backfill page boundaries and idempotent replay; weekend/holiday gaps treated as expected closure ONLY when verified schedule says so.
8. `OANDA_*` secrets never present in client bundle, API JSON, logs, URL, screenshots, or frontend source. Security tests scan for forbidden order/trade routes and OANDA authorization header leakage.
9. E2E check at 1440x900 and 390x844, existing five views stable, chart fallback remains functional.
10. `npm` tests, TypeScript check, lint, production build; enumerate commands and exact results.

## G. Feature gate / definition of done

Stage 2A success = **reliable, testable candle and time contracts**, not proof live market is connected. With no verified credentials / provider, app must remain `DATA SOURCE NOT CONNECTED`, no candles shown as current, zero confirmed signals. Keep all CRT logic disabled. Deliver a file-change summary, API response examples, test logs, and remaining prerequisites for Stage 2B authenticated market-data connection.

No other feature expansion. No Gemini market forecasts. No Telegram alerts. No 90% accuracy claims. No automated trade execution. **STOP after Stage 2A tests; do not proceed automatically to strategy engine.**
