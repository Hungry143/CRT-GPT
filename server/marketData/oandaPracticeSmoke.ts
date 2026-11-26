import { STAGE_2A_INVARIANTS } from '@/server/config/featureGates';
import { redactSensitiveText } from '@/server/marketData/adapter';
import {
  OANDA_ALLOWED_HOSTS,
  OandaV20MarketDataAdapter,
  type OandaAdapterDependencies,
} from '@/server/marketData/oandaV20Adapter';
import type {
  MarketDataProviderState,
  MarketGranularity,
  NormalizedCandle,
  ProviderInstrument,
} from '@/shared/contracts/marketData';
import type { VerifiedMarketSchedule } from '@/shared/utils/sessionClock';

export const OANDA_PRACTICE_SMOKE_GRANULARITIES: readonly MarketGranularity[] = [
  'M15',
  'H1',
  'H4',
  'D1',
] as const;

const SAFE_ACCOUNT_ID_REGEX = /^[A-Za-z0-9-]+$/;
const SAFE_INSTRUMENT_REGEX = /^[A-Z0-9_]+$/;

export interface SmokeTimeframeReport {
  granularity: MarketGranularity;
  ok: boolean;
  feedStatus: MarketDataProviderState;
  completedCandleCount: number;
  latestOpenTimeUtc: string | null;
  latestCloseTimeUtc: string | null;
  latestClosePrice: string | null;
  duplicateBarCount: number;
  missingBarCount: number;
  reasonCode: string | null;
  warnings: string[];
}

export interface OandaPracticeSmokeReport {
  status: 'PASSED' | 'SKIPPED' | 'REJECTED' | 'FAILED';
  checkedAtUtc: string;
  provider: 'oanda_v20';
  environment: 'practice';
  allowedHost: string;
  instrumentRequested: string;
  entitlementVerified: boolean;
  instrumentMetadata: ProviderInstrument | null;
  timeframes: SmokeTimeframeReport[];
  guarantees: {
    readOnly: true;
    practiceOnly: true;
    continuousIngestionActivated: false;
    backfillActivated: false;
    crtEngineEnabled: false;
    signalsEnabled: false;
    orderExecutionEnabled: false;
  };
  reasonCode: string | null;
  warnings: string[];
}

export interface RunOandaPracticeSmokeOptions {
  env?: Record<string, string | undefined>;
  sampleLimit?: number;
  verifiedSchedule?: VerifiedMarketSchedule | null;
  deps?: OandaAdapterDependencies;
  signal?: AbortSignal;
}

const GUARANTEES: OandaPracticeSmokeReport['guarantees'] = {
  readOnly: true,
  practiceOnly: true,
  continuousIngestionActivated: false,
  backfillActivated: false,
  crtEngineEnabled: STAGE_2A_INVARIANTS.crtEngineEnabled,
  signalsEnabled: STAGE_2A_INVARIANTS.signalsEnabled,
  orderExecutionEnabled: STAGE_2A_INVARIANTS.orderExecutionEnabled,
};

/**
 * Executes a single bounded, strictly read-only OANDA PRACTICE connectivity smoke test.
 *
 * Guarantees:
 * - Hard-rejects any OANDA_ENV other than `practice` (never touches api-fxtrade.oanda.com).
 * - Verifies account instrument entitlement for XAU_USD (`GET /v3/accounts/{id}/instruments`).
 * - Retrieves and validates completed XAU_USD candles for M15, H1, H4, and D1 (Daily).
 * - Never starts continuous ingestion, backfill loops, CRT signal generation, or broker execution.
 * - Redacts OANDA_API_TOKEN and OANDA_ACCOUNT_ID from every field in the returned report.
 */
export async function runOandaPracticeSmokeTest(
  options: RunOandaPracticeSmokeOptions = {}
): Promise<OandaPracticeSmokeReport> {
  const env = options.env ?? process.env;
  const nowFn = options.deps?.nowFn ?? (() => new Date());
  const checkedAtUtc = nowFn().toISOString();

  const rawEnv = (env.OANDA_ENV ?? '').trim().toLowerCase();
  const accountId = (env.OANDA_ACCOUNT_ID ?? '').trim();
  const apiToken = (env.OANDA_API_TOKEN ?? '').trim();
  const instrument = (env.OANDA_INSTRUMENT ?? 'XAU_USD').trim().toUpperCase();
  const secrets = [apiToken, accountId].filter((s) => s.length > 0);
  const sanitize = (msg: string) => redactSensitiveText(msg, secrets);

  // Hard guard: never permit non-practice environments (e.g. `live`)
  if (rawEnv && rawEnv !== 'practice') {
    return {
      status: 'REJECTED',
      checkedAtUtc,
      provider: 'oanda_v20',
      environment: 'practice',
      allowedHost: OANDA_ALLOWED_HOSTS.practice,
      instrumentRequested: instrument || 'XAU_USD',
      entitlementVerified: false,
      instrumentMetadata: null,
      timeframes: [],
      guarantees: GUARANTEES,
      reasonCode: 'PRACTICE_ENV_REQUIRED',
      warnings: [
        'Smoke test is strictly restricted to OANDA_ENV=practice (api-fxpractice.oanda.com). Live environments are rejected.',
      ],
    };
  }

  // Zero-credential clean skip when practice credentials are not provided
  if (!accountId || !apiToken) {
    return {
      status: 'SKIPPED',
      checkedAtUtc,
      provider: 'oanda_v20',
      environment: 'practice',
      allowedHost: OANDA_ALLOWED_HOSTS.practice,
      instrumentRequested: instrument || 'XAU_USD',
      entitlementVerified: false,
      instrumentMetadata: null,
      timeframes: [],
      guarantees: GUARANTEES,
      reasonCode: 'MISSING_PRACTICE_CREDENTIALS',
      warnings: [
        'Set OANDA_ENV=practice, OANDA_ACCOUNT_ID, OANDA_API_TOKEN, and OANDA_INSTRUMENT=XAU_USD in server environment to run the live read-only smoke test.',
      ],
    };
  }

  // Instrument scope guard: CRT Intelligence Stage 1/2A/2B is strictly XAU_USD only
  if (instrument !== 'XAU_USD') {
    return {
      status: 'REJECTED',
      checkedAtUtc,
      provider: 'oanda_v20',
      environment: 'practice',
      allowedHost: OANDA_ALLOWED_HOSTS.practice,
      instrumentRequested: instrument,
      entitlementVerified: false,
      instrumentMetadata: null,
      timeframes: [],
      guarantees: GUARANTEES,
      reasonCode: 'UNSUPPORTED_INSTRUMENT_SCOPE',
      warnings: ['Smoke test only permits XAU_USD instrument entitlement checks.'],
    };
  }

  if (
    !SAFE_ACCOUNT_ID_REGEX.test(accountId) ||
    !SAFE_INSTRUMENT_REGEX.test(instrument)
  ) {
    return {
      status: 'REJECTED',
      checkedAtUtc,
      provider: 'oanda_v20',
      environment: 'practice',
      allowedHost: OANDA_ALLOWED_HOSTS.practice,
      instrumentRequested: instrument,
      entitlementVerified: false,
      instrumentMetadata: null,
      timeframes: [],
      guarantees: GUARANTEES,
      reasonCode: 'INVALID_CONFIG_FORMAT',
      warnings: ['Invalid OANDA account ID or instrument identifier format.'],
    };
  }

  const sampleLimit = Math.max(1, Math.min(options.sampleLimit ?? 5, 20));
  const adapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId,
      apiToken,
      instrument: 'XAU_USD',
      verifiedSchedule: options.verifiedSchedule ?? null,
    },
    options.deps
  );

  const verification = await adapter.verifyInstrument(options.signal);
  if (!verification.verified || !verification.instrument) {
    const adapterStatus = await adapter.getStatus(nowFn());
    return {
      status: 'FAILED',
      checkedAtUtc: nowFn().toISOString(),
      provider: 'oanda_v20',
      environment: 'practice',
      allowedHost: OANDA_ALLOWED_HOSTS.practice,
      instrumentRequested: 'XAU_USD',
      entitlementVerified: false,
      instrumentMetadata: null,
      timeframes: [],
      guarantees: GUARANTEES,
      reasonCode: verification.reasonCode ?? 'ENTITLEMENT_VERIFICATION_FAILED',
      warnings: adapterStatus.quality.warnings.map(sanitize),
    };
  }

  const timeframes: SmokeTimeframeReport[] = [];
  const allWarnings: string[] = [];

  for (const granularity of OANDA_PRACTICE_SMOKE_GRANULARITIES) {
    const res = await adapter.fetchCompletedCandles({
      granularity,
      limit: sampleLimit,
      signal: options.signal,
    });

    // Prefer strictly healthy candles; during off-hours/unverified closures, fall back ONLY to
    // structurally validated historical completed bars (zero duplicates, strict OHLC/complete pass)
    // while reporting the honest feedStatus (e.g., STALE / FEED_DATA_STALE).
    const validatedCandles: NormalizedCandle[] =
      res.candles.length > 0
        ? res.candles
        : (res.validatedHistoricalCandles ?? []);
    const allComplete =
      validatedCandles.length > 0 && validatedCandles.every((c) => c.complete);
    const latest = validatedCandles.at(-1) ?? null;

    const ok =
      allComplete &&
      res.duplicateBarCount === 0 &&
      res.status !== 'AUTH_ERROR' &&
      res.status !== 'ERROR' &&
      res.status !== 'INSTRUMENT_UNAVAILABLE';

    const sanitizedWarnings = res.warnings.map(sanitize);
    allWarnings.push(...sanitizedWarnings);

    timeframes.push({
      granularity,
      ok,
      feedStatus: res.status,
      completedCandleCount: validatedCandles.length,
      latestOpenTimeUtc: latest?.openTimeUtc ?? null,
      latestCloseTimeUtc: latest?.closeTimeUtc ?? null,
      latestClosePrice: latest?.close ?? null,
      duplicateBarCount: res.duplicateBarCount,
      missingBarCount: res.missingBarCount,
      reasonCode: res.reasonCode,
      warnings: sanitizedWarnings,
    });
  }

  const allTimeframesOk = timeframes.every((tf) => tf.ok);

  return {
    status: allTimeframesOk ? 'PASSED' : 'FAILED',
    checkedAtUtc: nowFn().toISOString(),
    provider: 'oanda_v20',
    environment: 'practice',
    allowedHost: OANDA_ALLOWED_HOSTS.practice,
    instrumentRequested: 'XAU_USD',
    entitlementVerified: true,
    instrumentMetadata: verification.instrument,
    timeframes,
    guarantees: GUARANTEES,
    reasonCode: allTimeframesOk
      ? null
      : (timeframes.find((tf) => !tf.ok)?.reasonCode ?? 'SMOKE_CANDLE_FETCH_FAILED'),
    warnings: Array.from(new Set(allWarnings)),
  };
}
