import { z } from 'zod';
import type {
  AlignmentPolicy,
  MarketDataProviderState,
  MarketGranularity,
  NormalizedCandle,
  PriceBasis,
  ProviderInstrument,
} from '@/shared/contracts/marketData';
import {
  buildDeterministicCandleKey,
  validateCandleSeries,
} from '@/shared/utils/candleValidator';
import {
  computeCandleCloseTimeUtc,
  DEFAULT_ALIGNMENT_POLICY,
  type VerifiedMarketSchedule,
} from '@/shared/utils/sessionClock';
import {
  redactSensitiveText,
  type AdapterStatusSnapshot,
  type FetchCompletedCandlesRequest,
  type FetchCompletedCandlesResult,
  type MarketDataAdapter,
} from '@/server/marketData/adapter';

/**
 * Hardcoded HTTPS allowlist for OANDA v20 read-only REST endpoints.
 * No dynamic hostnames or non-HTTPS URLs are permitted.
 */
export const OANDA_ALLOWED_HOSTS = {
  practice: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
} as const;

export type OandaEnvironment = keyof typeof OANDA_ALLOWED_HOSTS;

export const OANDA_MAX_CANDLES_PER_REQUEST = 5000;

const OANDA_GRANULARITY_MAP: Record<MarketGranularity, string> = {
  D1: 'D',
  H4: 'H4',
  H1: 'H1',
  M15: 'M15',
  M1: 'M1',
};

const DAILY_ALIGNED_GRANULARITIES = new Set<MarketGranularity>([
  'D1',
  'H4',
  'H1',
  'M15',
]);

const SAFE_ACCOUNT_ID_REGEX = /^[A-Za-z0-9-]+$/;
const SAFE_INSTRUMENT_REGEX = /^[A-Z0-9_]+$/;

const OandaRawCandleSideSchema = z.object({
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
});

const OandaRawCandleSchema = z.object({
  complete: z.boolean(),
  volume: z.number().int().min(0).optional(),
  time: z.string(),
  mid: OandaRawCandleSideSchema.optional(),
  bid: OandaRawCandleSideSchema.optional(),
  ask: OandaRawCandleSideSchema.optional(),
});

const OandaCandlesPayloadSchema = z.object({
  instrument: z.string(),
  granularity: z.string(),
  candles: z.array(OandaRawCandleSchema),
});

const OandaAccountInstrumentSchema = z.object({
  name: z.string(),
  displayPrecision: z.number().int().optional(),
  pipLocation: z.number().int().optional(),
  minimumTradeSize: z.string().optional(),
});

const OandaAccountInstrumentsPayloadSchema = z.object({
  instruments: z.array(OandaAccountInstrumentSchema),
});

export interface OandaV20Config {
  env: OandaEnvironment;
  accountId: string;
  apiToken: string;
  instrument: string; // e.g. candidate XAU_USD (must still be verified against account)
  requestTimeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  verifiedSchedule?: VerifiedMarketSchedule | null;
}

export interface OandaAdapterDependencies {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  nowFn?: () => Date;
}

/**
 * Provider-neutral normalization step converting raw OANDA v20 candle payloads
 * into canonical NormalizedCandle objects validated by CandleValidator.
 */
export function normalizeOandaCandles(
  rawPayload: unknown,
  options: {
    granularity: MarketGranularity;
    priceBasis?: PriceBasis;
    retrievedAtUtc: string;
    nowUtc: Date;
    policy?: AlignmentPolicy;
    verifiedSchedule?: VerifiedMarketSchedule | null;
  }
) {
  const parsed = OandaCandlesPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error(
      `Invalid OANDA candles response schema: ${parsed.error.issues[0]?.message ?? 'malformed payload'}`
    );
  }

  const priceBasis = options.priceBasis ?? 'MID';
  const policy = options.policy ?? DEFAULT_ALIGNMENT_POLICY;
  const sideKey =
    priceBasis === 'MID' ? 'mid' : priceBasis === 'BID' ? 'bid' : 'ask';

  const normalizedCandidates: NormalizedCandle[] = [];
  for (const raw of parsed.data.candles) {
    const side = raw[sideKey];
    if (!side) continue;

    // Normalize RFC3339 timestamps (OANDA may include 9 fractional digits) to canonical ISO-8601 ms UTC
    const openDate = new Date(raw.time);
    if (Number.isNaN(openDate.getTime())) continue;
    const openTimeUtc = openDate.toISOString();
    const closeTimeUtc = computeCandleCloseTimeUtc(
      openTimeUtc,
      options.granularity,
      policy
    );

    normalizedCandidates.push({
      provider: 'oanda_v20',
      providerSymbol: parsed.data.instrument,
      granularity: options.granularity,
      priceBasis,
      openTimeUtc,
      closeTimeUtc,
      open: side.o,
      high: side.h,
      low: side.l,
      close: side.c,
      volume: typeof raw.volume === 'number' ? raw.volume : null,
      complete: raw.complete,
      sourceRetrievedAtUtc: options.retrievedAtUtc,
      sourceCandleId: buildDeterministicCandleKey({
        provider: 'oanda_v20',
        providerSymbol: parsed.data.instrument,
        priceBasis,
        granularity: options.granularity,
        openTimeUtc,
      }),
    });
  }

  return validateCandleSeries(normalizedCandidates, {
    nowUtc: options.nowUtc,
    policy,
    requireComplete: true,
    enforceGracePeriod: true,
    enforceIntervalAlignment: true,
    verifiedSchedule: options.verifiedSchedule ?? null,
  });
}

/**
 * Parses OANDA v20 server-only environment configuration safely.
 * Returns null if any required secret or identifier is missing/invalid.
 */
export function parseOandaConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): OandaV20Config | null {
  const rawEnv = env.OANDA_ENV?.trim().toLowerCase();
  const accountId = env.OANDA_ACCOUNT_ID?.trim();
  const apiToken = env.OANDA_API_TOKEN?.trim();
  const instrument = env.OANDA_INSTRUMENT?.trim().toUpperCase();

  if (
    (rawEnv !== 'practice' && rawEnv !== 'live') ||
    !accountId ||
    !apiToken ||
    !instrument
  ) {
    return null;
  }

  if (
    !SAFE_ACCOUNT_ID_REGEX.test(accountId) ||
    !SAFE_INSTRUMENT_REGEX.test(instrument)
  ) {
    return null;
  }

  return {
    env: rawEnv,
    accountId,
    apiToken,
    instrument,
  };
}

/**
 * Read-only OANDA v20 MarketDataAdapter skeleton.
 * Security guarantees:
 * - Strictly allowlisted HTTPS hostnames (api-fxpractice.oanda.com / api-fxtrade.oanda.com)
 * - Strictly GET requests to read-only market-data & account-instrument discovery endpoints ONLY
 * - Zero order/trade/position routes or mutating calls
 * - Privileged OANDA_API_TOKEN and account ID are redacted from every error, warning, and diagnostic string
 */
export class OandaV20MarketDataAdapter implements MarketDataAdapter {
  readonly adapterName = 'OandaV20MarketDataAdapter';
  readonly alignmentPolicy: AlignmentPolicy;

  private readonly config: OandaV20Config | null;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly nowFn: () => Date;

  private state: MarketDataProviderState = 'NOT_CONFIGURED';
  private verifiedInstrument: ProviderInstrument | null = null;
  private lastSuccessfulRequestUtc: string | null = null;
  private lastProviderCandleOpenUtc: string | null = null;
  private lastCompleteCandleCloseUtc: string | null = null;
  private missingBarCount: number | null = null;
  private duplicateBarCount: number | null = null;
  private warnings: string[] = [];
  private reasonCode: string | null = 'MISSING_CREDENTIALS';

  constructor(
    config: OandaV20Config | null,
    deps: OandaAdapterDependencies = {},
    policy: AlignmentPolicy = DEFAULT_ALIGNMENT_POLICY
  ) {
    this.config = config;
    this.alignmentPolicy = policy;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn =
      deps.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomFn = deps.randomFn ?? Math.random;
    this.nowFn = deps.nowFn ?? (() => new Date());

    if (!config) {
      this.state = 'NOT_CONFIGURED';
      this.reasonCode = 'MISSING_CREDENTIALS';
    } else {
      this.state = 'CONNECTING';
      this.reasonCode = 'AWAITING_INSTRUMENT_VERIFICATION';
    }
  }

  private getSecretsToRedact(): string[] {
    if (!this.config) return [];
    return [this.config.apiToken, this.config.accountId];
  }

  private buildAllowlistedUrl(
    endpointPath: string,
    query?: URLSearchParams
  ): string {
    if (!this.config) {
      throw new Error('OANDA configuration missing');
    }
    const base = OANDA_ALLOWED_HOSTS[this.config.env];
    const url = new URL(endpointPath, base);

    if (url.protocol !== 'https:' || url.origin !== base) {
      throw new Error('Disallowed OANDA endpoint origin');
    }
    // Explicitly block any order/trade/position paths as defense in depth
    if (/\/(orders|trades|positions|transactions)\b/i.test(url.pathname)) {
      throw new Error('Forbidden broker execution path blocked');
    }

    if (query) {
      url.search = query.toString();
    }
    return url.toString();
  }

  private async executeReadOnlyGet(
    url: string,
    externalSignal?: AbortSignal
  ): Promise<{ ok: true; json: unknown } | { ok: false; status: number | null; error: string }> {
    if (!this.config) {
      return { ok: false, status: null, error: 'Missing OANDA configuration' };
    }

    const timeoutMs = this.config.requestTimeoutMs ?? 8000;
    const maxRetries = this.config.maxRetries ?? 2;
    const baseDelayMs = this.config.baseRetryDelayMs ?? 250;

    let attempt = 0;
    while (attempt <= maxRetries) {
      if (externalSignal?.aborted) {
        return { ok: false, status: null, error: 'Request aborted' };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const res = await this.fetchFn(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            Accept: 'application/json',
            'Accept-Datetime-Format': 'RFC3339',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onExternalAbort);

        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            status: res.status,
            error: `OANDA authentication rejected (HTTP ${res.status})`,
          };
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt < maxRetries) {
            const backoff = baseDelayMs * 2 ** attempt;
            const jitter = Math.floor(this.randomFn() * Math.max(25, backoff * 0.3));
            await this.sleepFn(backoff + jitter);
            attempt += 1;
            continue;
          }
          return {
            ok: false,
            status: res.status,
            error: `OANDA upstream unavailable after retries (HTTP ${res.status})`,
          };
        }

        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            error: `OANDA read-only request failed (HTTP ${res.status})`,
          };
        }

        const json: unknown = await res.json();
        return { ok: true, json };
      } catch (err) {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onExternalAbort);

        const rawMsg = err instanceof Error ? err.message : 'Network error';
        if (attempt < maxRetries && !externalSignal?.aborted) {
          const backoff = baseDelayMs * 2 ** attempt;
          const jitter = Math.floor(this.randomFn() * Math.max(25, backoff * 0.3));
          await this.sleepFn(backoff + jitter);
          attempt += 1;
          continue;
        }
        return {
          ok: false,
          status: null,
          error: redactSensitiveText(rawMsg, this.getSecretsToRedact()),
        };
      }
    }

    return { ok: false, status: null, error: 'Retry limit reached' };
  }

  async verifyInstrument(signal?: AbortSignal) {
    if (!this.config) {
      this.state = 'NOT_CONFIGURED';
      this.verifiedInstrument = null;
      this.reasonCode = 'MISSING_CREDENTIALS';
      return {
        verified: false,
        state: this.state,
        instrument: null,
        reasonCode: this.reasonCode,
      };
    }

    if (
      !SAFE_ACCOUNT_ID_REGEX.test(this.config.accountId) ||
      !SAFE_INSTRUMENT_REGEX.test(this.config.instrument)
    ) {
      this.state = 'ERROR';
      this.reasonCode = 'INVALID_CONFIG_FORMAT';
      return {
        verified: false,
        state: this.state,
        instrument: null,
        reasonCode: this.reasonCode,
      };
    }

    const query = new URLSearchParams({ instruments: this.config.instrument });
    const url = this.buildAllowlistedUrl(
      `/v3/accounts/${encodeURIComponent(this.config.accountId)}/instruments`,
      query
    );

    const response = await this.executeReadOnlyGet(url, signal);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.state = 'AUTH_ERROR';
        this.reasonCode = 'PROVIDER_AUTH_FAILED';
      } else {
        this.state = this.lastSuccessfulRequestUtc ? 'STALE' : 'ERROR';
        this.reasonCode = 'PROVIDER_UNREACHABLE';
      }
      this.verifiedInstrument = null;
      this.warnings = [
        redactSensitiveText(response.error, this.getSecretsToRedact()),
      ];
      return {
        verified: false,
        state: this.state,
        instrument: null,
        reasonCode: this.reasonCode,
      };
    }

    const parsed = OandaAccountInstrumentsPayloadSchema.safeParse(response.json);
    if (!parsed.success) {
      this.state = 'ERROR';
      this.reasonCode = 'MALFORMED_INSTRUMENTS_RESPONSE';
      this.verifiedInstrument = null;
      return {
        verified: false,
        state: this.state,
        instrument: null,
        reasonCode: this.reasonCode,
      };
    }

    const matched = parsed.data.instruments.find(
      (item) => item.name === this.config?.instrument
    );
    if (!matched) {
      this.state = 'INSTRUMENT_UNAVAILABLE';
      this.reasonCode = 'INSTRUMENT_NOT_ELIGIBLE_ON_ACCOUNT';
      this.verifiedInstrument = null;
      return {
        verified: false,
        state: this.state,
        instrument: null,
        reasonCode: this.reasonCode,
      };
    }

    const nowUtc = this.nowFn().toISOString();
    this.lastSuccessfulRequestUtc = nowUtc;
    this.state = 'CONNECTED';
    this.reasonCode = null;
    this.warnings = [];
    this.verifiedInstrument = {
      displaySymbol: 'XAUUSD',
      providerName: 'oanda_v20',
      providerSymbol: matched.name,
      pricePrecision:
        typeof matched.displayPrecision === 'number'
          ? matched.displayPrecision
          : null,
      pipLocation:
        typeof matched.pipLocation === 'number' ? matched.pipLocation : null,
      minTradeSize: matched.minimumTradeSize ?? null,
      verified: true,
      verifiedAtUtc: nowUtc,
    };

    return {
      verified: true,
      state: this.state,
      instrument: this.verifiedInstrument,
      reasonCode: null,
    };
  }

  async fetchCompletedCandles(
    request: FetchCompletedCandlesRequest
  ): Promise<FetchCompletedCandlesResult> {
    const retrievedAtUtc = this.nowFn().toISOString();

    if (!this.config) {
      this.state = 'NOT_CONFIGURED';
      this.reasonCode = 'MISSING_CREDENTIALS';
      return {
        status: 'NOT_CONFIGURED',
        candles: [],
        retrievedAtUtc,
        duplicateBarCount: 0,
        missingBarCount: 0,
        warnings: [],
        reasonCode: this.reasonCode,
      };
    }

    if (!this.verifiedInstrument) {
      const verification = await this.verifyInstrument(request.signal);
      if (!verification.verified || !verification.instrument) {
        return {
          status: verification.state,
          candles: [],
          retrievedAtUtc,
          duplicateBarCount: 0,
          missingBarCount: 0,
          warnings: [...this.warnings],
          reasonCode: verification.reasonCode,
        };
      }
    }

    const boundedCount = Math.max(
      1,
      Math.min(request.limit, OANDA_MAX_CANDLES_PER_REQUEST)
    );
    const oandaGranularity = OANDA_GRANULARITY_MAP[request.granularity];
    const query = new URLSearchParams({
      granularity: oandaGranularity,
      price: 'M',
      smooth: 'false',
    });

    if (DAILY_ALIGNED_GRANULARITIES.has(request.granularity)) {
      query.set('dailyAlignment', String(this.alignmentPolicy.dailyRollHourNy));
      query.set('alignmentTimezone', this.alignmentPolicy.alignmentTimezone);
      if (this.alignmentPolicy.weeklyAlignment) {
        query.set('weeklyAlignment', this.alignmentPolicy.weeklyAlignment);
      }
    }

    if (request.fromUtc) {
      query.set('from', request.fromUtc);
      if (request.toUtc) {
        query.set('to', request.toUtc);
      } else {
        query.set('count', String(boundedCount));
      }
      if (typeof request.includeFirst === 'boolean') {
        query.set('includeFirst', String(request.includeFirst));
      }
    } else {
      query.set('count', String(boundedCount));
    }

    const url = this.buildAllowlistedUrl(
      `/v3/instruments/${encodeURIComponent(this.config.instrument)}/candles`,
      query
    );

    const response = await this.executeReadOnlyGet(url, request.signal);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.state = 'AUTH_ERROR';
        this.reasonCode = 'PROVIDER_AUTH_FAILED';
      } else {
        this.state = this.lastSuccessfulRequestUtc ? 'STALE' : 'ERROR';
        this.reasonCode = 'FEED_REQUEST_FAILED';
      }
      const safeWarn = redactSensitiveText(
        response.error,
        this.getSecretsToRedact()
      );
      this.warnings = [safeWarn];
      return {
        status: this.state,
        candles: [],
        retrievedAtUtc,
        duplicateBarCount: 0,
        missingBarCount: 0,
        warnings: [safeWarn],
        reasonCode: this.reasonCode,
      };
    }

    try {
      const nowUtc = this.nowFn();
      const validation = normalizeOandaCandles(response.json, {
        granularity: request.granularity,
        priceBasis: 'MID',
        retrievedAtUtc: nowUtc.toISOString(),
        nowUtc,
        policy: this.alignmentPolicy,
        verifiedSchedule: this.config.verifiedSchedule ?? null,
      });

      this.lastSuccessfulRequestUtc = nowUtc.toISOString();
      this.duplicateBarCount = validation.duplicateBarCount;
      this.missingBarCount = validation.missingBarCount;
      this.warnings = validation.warnings;
      this.state = 'CONNECTED';
      this.reasonCode = null;

      const latest = validation.accepted.at(-1) ?? null;
      if (latest) {
        this.lastProviderCandleOpenUtc = latest.openTimeUtc;
        this.lastCompleteCandleCloseUtc = latest.closeTimeUtc;
      }

      return {
        status: this.state,
        candles: validation.accepted,
        retrievedAtUtc: nowUtc.toISOString(),
        duplicateBarCount: validation.duplicateBarCount,
        missingBarCount: validation.missingBarCount,
        warnings: validation.warnings,
        reasonCode: null,
      };
    } catch (err) {
      const msg = redactSensitiveText(
        err instanceof Error ? err.message : 'Normalization failed',
        this.getSecretsToRedact()
      );
      this.state = 'ERROR';
      this.reasonCode = 'NORMALIZATION_ERROR';
      this.warnings = [msg];
      return {
        status: 'ERROR',
        candles: [],
        retrievedAtUtc,
        duplicateBarCount: 0,
        missingBarCount: 0,
        warnings: [msg],
        reasonCode: this.reasonCode,
      };
    }
  }

  async getStatus(now: Date = this.nowFn()): Promise<AdapterStatusSnapshot> {
    const freshnessSeconds =
      this.lastCompleteCandleCloseUtc !== null
        ? Math.max(
            0,
            Math.floor(
              (now.getTime() - Date.parse(this.lastCompleteCandleCloseUtc)) / 1000
            )
          )
        : null;

    return {
      adapterName: this.adapterName,
      providerVerified: this.verifiedInstrument?.verified === true,
      instrument: this.verifiedInstrument,
      quality: {
        state: this.state,
        lastSuccessfulRequestUtc: this.lastSuccessfulRequestUtc,
        lastProviderCandleOpenUtc: this.lastProviderCandleOpenUtc,
        lastCompleteCandleCloseUtc: this.lastCompleteCandleCloseUtc,
        freshnessSeconds,
        missingBarCount: this.missingBarCount,
        duplicateBarCount: this.duplicateBarCount,
        alignmentPolicy: this.alignmentPolicy,
        warnings: [...this.warnings],
        reasonCode: this.reasonCode,
      },
    };
  }
}
