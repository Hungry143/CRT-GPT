import { createHash, timingSafeEqual } from 'node:crypto';
import {
  STAGE_2A_INVARIANTS,
  readBackfillEnabled,
  readFeatureGates,
} from '@/server/config/featureGates';
import {
  runOandaPracticeSmokeTest,
  type OandaPracticeSmokeReport,
  type RunOandaPracticeSmokeOptions,
  type SmokeTimeframeReport,
} from '@/server/marketData/oandaPracticeSmoke';
import type {
  MarketDataProviderState,
  MarketGranularity,
} from '@/shared/contracts/marketData';

export const DIAGNOSTIC_MIN_SECRET_LENGTH = 32;
export const DIAGNOSTIC_RATE_LIMIT_WINDOW_MS = 60_000;
export const DIAGNOSTIC_RATE_LIMIT_MAX_PER_CLIENT = 5;
export const DIAGNOSTIC_RATE_LIMIT_MAX_GLOBAL = 10;

export type DiagnosticTimeframeFreshnessState =
  | 'FRESH_LIVE'
  | 'STALE_HISTORICAL'
  | 'MARKET_CLOSED_HISTORICAL'
  | 'NO_COMPLETED_CANDLES'
  | 'ERROR';

export type DiagnosticFreshnessClassification =
  | 'FRESH_LIVE_SYNCED'
  | 'VALID_HISTORICAL_ONLY_STALE'
  | 'VALID_HISTORICAL_MARKET_CLOSED'
  | 'UNAVAILABLE_OR_INVALID';

export interface DiagnosticCredentialPresence {
  OANDA_ENV_PRESENT: boolean;
  OANDA_ENV_IS_PRACTICE: boolean;
  OANDA_ACCOUNT_ID_PRESENT: boolean;
  OANDA_API_TOKEN_PRESENT: boolean;
  OANDA_INSTRUMENT_PRESENT: boolean;
  OANDA_INSTRUMENT_IS_XAU_USD: boolean;
}

export interface DiagnosticTimeframeSummary {
  granularity: MarketGranularity;
  completedCandleCount: number;
  latestOpenTimeUtc: string | null;
  latestCloseTimeUtc: string | null;
  feedStatus: MarketDataProviderState;
  freshnessState: DiagnosticTimeframeFreshnessState;
  validHistoricalData: boolean;
  isFreshLiveData: boolean;
  missingBarCount: number;
  duplicateBarCount: number;
  reasonCode: string | null;
}

export interface DiagnosticDataFreshnessSummary {
  historicalCandlesValid: boolean;
  liveFeedFreshNow: boolean;
  freshnessClassification: DiagnosticFreshnessClassification;
}

export interface OandaPracticeDiagnosticResponse {
  status: 'PASSED' | 'SKIPPED' | 'REJECTED' | 'FAILED';
  checkedAtUtc: string;
  instrument: 'XAU_USD';
  environmentScope: 'practice';
  credentialPresence: DiagnosticCredentialPresence;
  entitlementVerified: boolean;
  dataFreshnessSummary: DiagnosticDataFreshnessSummary;
  timeframes: DiagnosticTimeframeSummary[];
  reasonCode: string | null;
  guarantees: {
    readOnly: true;
    practiceOnly: true;
    continuousIngestionActivated: false;
    backfillActivated: false;
    marketFeedEnabled: boolean;
    backfillEnabled: boolean;
    crtEngineEnabled: false;
    signalsEnabled: false;
    orderExecutionEnabled: false;
  };
}

export interface DiagnosticErrorResponse {
  error: string;
  reasonCode: string;
  checkedAtUtc: string;
}

export interface DiagnosticHttpResult {
  httpStatus: number;
  headers: Record<string, string>;
  body: OandaPracticeDiagnosticResponse | DiagnosticErrorResponse;
}

export interface DiagnosticRequestContext {
  method: string;
  url: string;
  headers: {
    get(name: string): string | null;
  };
}

export interface DiagnosticRateLimitState {
  perClientTimestamps: Map<string, number[]>;
  globalTimestamps: number[];
  inFlight: boolean;
}

const RATE_LIMIT_SYMBOL = Symbol.for(
  'crt.intelligence.oandaPracticeDiagnosticRateLimiter'
);

type GlobalWithDiagnosticLimiter = typeof globalThis & {
  [RATE_LIMIT_SYMBOL]?: DiagnosticRateLimitState;
};

export function createDiagnosticRateLimitState(): DiagnosticRateLimitState {
  return {
    perClientTimestamps: new Map<string, number[]>(),
    globalTimestamps: [],
    inFlight: false,
  };
}

function getProcessDiagnosticRateLimitState(): DiagnosticRateLimitState {
  const g = globalThis as GlobalWithDiagnosticLimiter;
  if (!g[RATE_LIMIT_SYMBOL]) {
    g[RATE_LIMIT_SYMBOL] = createDiagnosticRateLimitState();
  }
  return g[RATE_LIMIT_SYMBOL];
}

export function resetDiagnosticRateLimitState(): void {
  const g = globalThis as GlobalWithDiagnosticLimiter;
  g[RATE_LIMIT_SYMBOL] = createDiagnosticRateLimitState();
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function parseBooleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function constantTimeSecretEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function isPrivateDevelopmentOrPreviewEnvironment(
  env: Record<string, string | undefined>,
  requestHost: string
): { allowed: true } | { allowed: false; reasonCode: string } {
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  const vercelEnv = (env.VERCEL_ENV ?? '').trim().toLowerCase();
  const hostLower = requestHost.trim().toLowerCase().split(':')[0] ?? '';

  // Hard block explicit production environments and shared/public preview hosts (e.g. ais-pre-*)
  if (appEnv === 'production' || vercelEnv === 'production') {
    return { allowed: false, reasonCode: 'PRODUCTION_DIAGNOSTIC_FORBIDDEN' };
  }
  if (hostLower.startsWith('ais-pre-')) {
    return { allowed: false, reasonCode: 'SHARED_PREVIEW_DIAGNOSTIC_FORBIDDEN' };
  }

  // Always disallow standard production builds (`NODE_ENV=production`)
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    return { allowed: false, reasonCode: 'NON_DEV_ENVIRONMENT_FORBIDDEN' };
  }

  return { allowed: true };
}

function validateConfiguredDiagnosticSecret(
  env: Record<string, string | undefined>
): { ok: true; secret: string } | { ok: false; reasonCode: string } {
  const diagnosticSecret = (env.OANDA_PRACTICE_DIAGNOSTIC_SECRET ?? '').trim();
  if (!diagnosticSecret) {
    return { ok: false, reasonCode: 'DIAGNOSTIC_SECRET_NOT_CONFIGURED' };
  }
  if (diagnosticSecret.length < DIAGNOSTIC_MIN_SECRET_LENGTH) {
    return { ok: false, reasonCode: 'DIAGNOSTIC_SECRET_TOO_SHORT' };
  }

  const oandaToken = (env.OANDA_API_TOKEN ?? '').trim();
  const oandaAccount = (env.OANDA_ACCOUNT_ID ?? '').trim();
  if (
    (oandaToken && constantTimeSecretEquals(diagnosticSecret, oandaToken)) ||
    (oandaAccount && constantTimeSecretEquals(diagnosticSecret, oandaAccount))
  ) {
    return { ok: false, reasonCode: 'DIAGNOSTIC_SECRET_MUST_BE_SEPARATE' };
  }

  return { ok: true, secret: diagnosticSecret };
}

function extractRequestSecret(headers: DiagnosticRequestContext['headers']): string | null {
  const customHeader = headers.get('x-crt-diagnostic-secret')?.trim();
  if (customHeader) {
    return customHeader;
  }

  const authHeader = headers.get('authorization')?.trim();
  if (authHeader && /^Bearer\s+\S+$/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  return null;
}

function hasForbiddenQuerySecret(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr, 'http://localhost:3000');
    for (const key of parsed.searchParams.keys()) {
      if (/(secret|token|key|auth|password|account)/i.test(key)) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function computeClientRateLimitKey(headers: DiagnosticRequestContext['headers']): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const realIp = headers.get('x-real-ip')?.trim() ?? '';
  const raw = forwarded || realIp || 'local-client';
  return createHash('sha256').update(`rl:${raw}`).digest('hex').slice(0, 16);
}

function checkAndRecordRateLimit(
  state: DiagnosticRateLimitState,
  clientKey: string,
  nowMs: number,
  options: {
    windowMs?: number;
    maxPerClient?: number;
    maxGlobal?: number;
  } = {}
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const windowMs = options.windowMs ?? DIAGNOSTIC_RATE_LIMIT_WINDOW_MS;
  const maxPerClient =
    options.maxPerClient ?? DIAGNOSTIC_RATE_LIMIT_MAX_PER_CLIENT;
  const maxGlobal = options.maxGlobal ?? DIAGNOSTIC_RATE_LIMIT_MAX_GLOBAL;
  const cutoff = nowMs - windowMs;

  // Prune expired global timestamps
  state.globalTimestamps = state.globalTimestamps.filter((ts) => ts > cutoff);

  // Prune expired client timestamps and bound map size
  const clientTimestamps = (state.perClientTimestamps.get(clientKey) ?? []).filter(
    (ts) => ts > cutoff
  );

  if (state.globalTimestamps.length >= maxGlobal) {
    const oldest = state.globalTimestamps[0] ?? nowMs;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - nowMs) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  if (clientTimestamps.length >= maxPerClient) {
    const oldest = clientTimestamps[0] ?? nowMs;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - nowMs) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  clientTimestamps.push(nowMs);
  state.perClientTimestamps.set(clientKey, clientTimestamps);
  state.globalTimestamps.push(nowMs);

  // Bound memory for tracked client keys
  if (state.perClientTimestamps.size > 256) {
    for (const [key, list] of state.perClientTimestamps.entries()) {
      const pruned = list.filter((ts) => ts > cutoff);
      if (pruned.length === 0) {
        state.perClientTimestamps.delete(key);
      } else {
        state.perClientTimestamps.set(key, pruned);
      }
    }
  }

  return { allowed: true };
}

/**
 * Inspects OANDA server environment variables and returns strictly boolean
 * presence/validation flags — NEVER raw values, tokens, or account IDs.
 */
export function inspectOandaCredentialPresence(
  env: Record<string, string | undefined>
): DiagnosticCredentialPresence {
  const rawEnv = (env.OANDA_ENV ?? '').trim().toLowerCase();
  const rawAccountId = (env.OANDA_ACCOUNT_ID ?? '').trim();
  const rawApiToken = (env.OANDA_API_TOKEN ?? '').trim();
  const rawInstrument = (env.OANDA_INSTRUMENT ?? '').trim().toUpperCase();

  return {
    OANDA_ENV_PRESENT: rawEnv.length > 0,
    OANDA_ENV_IS_PRACTICE: rawEnv === 'practice',
    OANDA_ACCOUNT_ID_PRESENT: rawAccountId.length > 0,
    OANDA_API_TOKEN_PRESENT: rawApiToken.length > 0,
    OANDA_INSTRUMENT_PRESENT: rawInstrument.length > 0,
    OANDA_INSTRUMENT_IS_XAU_USD: rawInstrument === 'XAU_USD',
  };
}

function classifyTimeframe(
  tf: SmokeTimeframeReport
): DiagnosticTimeframeSummary {
  const validHistoricalData =
    tf.ok && tf.completedCandleCount > 0 && tf.duplicateBarCount === 0;
  // Strictly distinguish fresh live data from valid historical data:
  // STALE, MARKET_CLOSED, CONNECTING, or gaps NEVER count as currently fresh live data.
  const isFreshLiveData =
    validHistoricalData &&
    tf.feedStatus === 'CONNECTED' &&
    tf.missingBarCount === 0;

  let freshnessState: DiagnosticTimeframeFreshnessState;
  if (!validHistoricalData) {
    freshnessState =
      tf.completedCandleCount === 0 && tf.feedStatus === 'CONNECTING'
        ? 'NO_COMPLETED_CANDLES'
        : 'ERROR';
  } else if (isFreshLiveData) {
    freshnessState = 'FRESH_LIVE';
  } else if (tf.feedStatus === 'MARKET_CLOSED') {
    freshnessState = 'MARKET_CLOSED_HISTORICAL';
  } else {
    freshnessState = 'STALE_HISTORICAL';
  }

  return {
    granularity: tf.granularity,
    completedCandleCount: tf.completedCandleCount,
    latestOpenTimeUtc: tf.latestOpenTimeUtc,
    latestCloseTimeUtc: tf.latestCloseTimeUtc,
    feedStatus: tf.feedStatus,
    freshnessState,
    validHistoricalData,
    isFreshLiveData,
    missingBarCount: tf.missingBarCount,
    duplicateBarCount: tf.duplicateBarCount,
    reasonCode: tf.reasonCode,
  };
}

function summarizeDataFreshness(
  report: OandaPracticeSmokeReport,
  timeframes: readonly DiagnosticTimeframeSummary[]
): DiagnosticDataFreshnessSummary {
  const historicalCandlesValid =
    report.status === 'PASSED' &&
    report.entitlementVerified &&
    timeframes.length === 4 &&
    timeframes.every((tf) => tf.validHistoricalData);

  const liveFeedFreshNow =
    historicalCandlesValid && timeframes.every((tf) => tf.isFreshLiveData);

  let freshnessClassification: DiagnosticFreshnessClassification;
  if (!historicalCandlesValid) {
    freshnessClassification = 'UNAVAILABLE_OR_INVALID';
  } else if (liveFeedFreshNow) {
    freshnessClassification = 'FRESH_LIVE_SYNCED';
  } else if (
    timeframes.every(
      (tf) =>
        tf.freshnessState === 'FRESH_LIVE' ||
        tf.freshnessState === 'MARKET_CLOSED_HISTORICAL'
    )
  ) {
    freshnessClassification = 'VALID_HISTORICAL_MARKET_CLOSED';
  } else {
    freshnessClassification = 'VALID_HISTORICAL_ONLY_STALE';
  }

  return {
    historicalCandlesValid,
    liveFeedFreshNow,
    freshnessClassification,
  };
}

export interface HandleOandaPracticeDiagnosticOptions {
  env?: Record<string, string | undefined>;
  nowFn?: () => Date;
  rateLimitState?: DiagnosticRateLimitState;
  rateLimitConfig?: {
    windowMs?: number;
    maxPerClient?: number;
    maxGlobal?: number;
  };
  smokeOptions?: Omit<RunOandaPracticeSmokeOptions, 'env'>;
}

/**
 * Strictly protected, POST-only, rate-limited, preview/development-only diagnostic handler.
 * Reuses `runOandaPracticeSmokeTest()` inside the Next.js server runtime without activating
 * continuous ingestion, backfill, CRT engine, signals, or broker execution.
 */
export async function handleOandaPracticeDiagnosticRequest(
  req: DiagnosticRequestContext,
  options: HandleOandaPracticeDiagnosticOptions = {}
): Promise<DiagnosticHttpResult> {
  const env = options.env ?? process.env;
  const nowFn = options.nowFn ?? (() => new Date());
  const nowDate = nowFn();
  const checkedAtUtc = nowDate.toISOString();

  // 1. POST-only method guard
  if (req.method.toUpperCase() !== 'POST') {
    return {
      httpStatus: 405,
      headers: {
        ...SECURITY_HEADERS,
        Allow: 'POST',
      },
      body: {
        error: 'Method not allowed; diagnostic requires POST.',
        reasonCode: 'METHOD_NOT_ALLOWED',
        checkedAtUtc,
      },
    };
  }

  // 2. Disabled by default (must be explicitly opted in)
  if (!parseBooleanFlag(env.OANDA_PRACTICE_DIAGNOSTIC_ENABLED)) {
    return {
      httpStatus: 404,
      headers: { ...SECURITY_HEADERS },
      body: {
        error: 'OANDA practice diagnostic is disabled.',
        reasonCode: 'DIAGNOSTIC_DISABLED',
        checkedAtUtc,
      },
    };
  }

  // 3. Private development/preview environment guard (never available in public production)
  const requestHost =
    req.headers.get('x-forwarded-host') ??
    req.headers.get('host') ??
    (() => {
      try {
        return new URL(req.url).host;
      } catch {
        return '';
      }
    })();

  const envCheck = isPrivateDevelopmentOrPreviewEnvironment(env, requestHost);
  if (!envCheck.allowed) {
    return {
      httpStatus: 404,
      headers: { ...SECURITY_HEADERS },
      body: {
        error: 'OANDA practice diagnostic is unavailable in this environment.',
        reasonCode: envCheck.reasonCode,
        checkedAtUtc,
      },
    };
  }

  // 4. Reject secrets passed in URL query strings (prevents log/history leakage)
  if (hasForbiddenQuerySecret(req.url)) {
    return {
      httpStatus: 400,
      headers: { ...SECURITY_HEADERS },
      body: {
        error: 'Secrets must never be passed in URL query parameters.',
        reasonCode: 'QUERY_SECRET_FORBIDDEN',
        checkedAtUtc,
      },
    };
  }

  // 5. Separate strong server-side diagnostic secret must be configured
  const secretValidation = validateConfiguredDiagnosticSecret(env);
  if (!secretValidation.ok) {
    return {
      httpStatus: 503,
      headers: { ...SECURITY_HEADERS },
      body: {
        error:
          'Diagnostic endpoint requires a strong separate server-side diagnostic secret (>= 32 chars).',
        reasonCode: secretValidation.reasonCode,
        checkedAtUtc,
      },
    };
  }

  // 6. Rate limiting (guards both auth probing and upstream OANDA calls)
  const rateLimitState =
    options.rateLimitState ?? getProcessDiagnosticRateLimitState();
  const clientKey = computeClientRateLimitKey(req.headers);
  const rateCheck = checkAndRecordRateLimit(
    rateLimitState,
    clientKey,
    nowDate.getTime(),
    options.rateLimitConfig
  );
  if (!rateCheck.allowed) {
    return {
      httpStatus: 429,
      headers: {
        ...SECURITY_HEADERS,
        'Retry-After': String(rateCheck.retryAfterSeconds),
      },
      body: {
        error: 'Diagnostic rate limit exceeded. Retry later.',
        reasonCode: 'DIAGNOSTIC_RATE_LIMITED',
        checkedAtUtc,
      },
    };
  }

  // 7. Constant-time authentication against separate server-side diagnostic secret
  const providedSecret = extractRequestSecret(req.headers);
  if (
    !providedSecret ||
    !constantTimeSecretEquals(providedSecret, secretValidation.secret)
  ) {
    return {
      httpStatus: 401,
      headers: {
        ...SECURITY_HEADERS,
        'WWW-Authenticate': 'Bearer realm="crt-practice-diagnostic"',
      },
      body: {
        error: 'Unauthorized diagnostic request.',
        reasonCode: 'DIAGNOSTIC_AUTH_REQUIRED',
        checkedAtUtc,
      },
    };
  }

  // 8. Prevent overlapping diagnostic runs
  if (rateLimitState.inFlight) {
    return {
      httpStatus: 429,
      headers: {
        ...SECURITY_HEADERS,
        'Retry-After': '5',
      },
      body: {
        error: 'Another diagnostic check is already in progress.',
        reasonCode: 'DIAGNOSTIC_IN_FLIGHT',
        checkedAtUtc,
      },
    };
  }

  const credentialPresence = inspectOandaCredentialPresence(env);
  const gates = readFeatureGates(env);
  const backfillEnabled = readBackfillEnabled(env);

  rateLimitState.inFlight = true;
  try {
    // Only invoke upstream OANDA PRACTICE smoke check when all required presence/scope
    // preconditions hold; otherwise reuse runOandaPracticeSmokeTest() which cleanly skips/rejects
    // with zero network calls.
    const smokeReport = await runOandaPracticeSmokeTest({
      ...options.smokeOptions,
      env,
      sampleLimit: Math.max(
        1,
        Math.min(options.smokeOptions?.sampleLimit ?? 5, 10)
      ),
      deps: {
        ...options.smokeOptions?.deps,
        nowFn: options.smokeOptions?.deps?.nowFn ?? nowFn,
      },
    });

    const timeframes = smokeReport.timeframes.map(classifyTimeframe);
    const dataFreshnessSummary = summarizeDataFreshness(
      smokeReport,
      timeframes
    );

    return {
      httpStatus: 200,
      headers: { ...SECURITY_HEADERS },
      body: {
        status: smokeReport.status,
        checkedAtUtc: smokeReport.checkedAtUtc,
        instrument: 'XAU_USD',
        environmentScope: 'practice',
        credentialPresence,
        entitlementVerified: smokeReport.entitlementVerified,
        dataFreshnessSummary,
        timeframes,
        reasonCode: smokeReport.reasonCode,
        guarantees: {
          readOnly: true,
          practiceOnly: true,
          continuousIngestionActivated: false,
          backfillActivated: false,
          marketFeedEnabled: gates.MARKET_FEED_ENABLED,
          backfillEnabled,
          crtEngineEnabled: STAGE_2A_INVARIANTS.crtEngineEnabled,
          signalsEnabled: STAGE_2A_INVARIANTS.signalsEnabled,
          orderExecutionEnabled: STAGE_2A_INVARIANTS.orderExecutionEnabled,
        },
      },
    };
  } catch {
    return {
      httpStatus: 500,
      headers: { ...SECURITY_HEADERS },
      body: {
        error: 'OANDA practice diagnostic execution failed.',
        reasonCode: 'DIAGNOSTIC_EXECUTION_ERROR',
        checkedAtUtc: nowFn().toISOString(),
      },
    };
  } finally {
    rateLimitState.inFlight = false;
  }
}
