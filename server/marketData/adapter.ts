import type {
  AlignmentPolicy,
  FeedQuality,
  MarketDataProviderState,
  MarketGranularity,
  NormalizedCandle,
  ProviderInstrument,
} from '@/shared/contracts/marketData';
import { DEFAULT_ALIGNMENT_POLICY } from '@/shared/utils/sessionClock';

export interface FetchCompletedCandlesRequest {
  granularity: MarketGranularity;
  limit: number;
  fromUtc?: string;
  toUtc?: string;
  includeFirst?: boolean;
  signal?: AbortSignal;
}

export interface FetchCompletedCandlesResult {
  status: MarketDataProviderState;
  candles: NormalizedCandle[];
  /**
   * Populated ONLY when a fetch fails closed due to an unknown-closure gap (UNEXPECTED_BAR_GAP)
   * with zero structural OHLC/duplicate corruption, allowing durable backfill workers to preserve
   * individually validated historical candles without permanently losing history or stalling cursors.
   */
  validatedHistoricalCandles?: NormalizedCandle[];
  retrievedAtUtc: string;
  duplicateBarCount: number;
  missingBarCount: number;
  warnings: string[];
  reasonCode: string | null;
}

export interface AdapterStatusSnapshot {
  adapterName: string;
  providerVerified: boolean;
  instrument: ProviderInstrument | null;
  quality: FeedQuality;
}

/**
 * Read-only MarketDataAdapter interface.
 * Explicitly excludes all order, trade, position, or broker-account mutation operations.
 */
export interface MarketDataAdapter {
  readonly adapterName: string;
  readonly alignmentPolicy: AlignmentPolicy;
  getStatus(now?: Date): Promise<AdapterStatusSnapshot>;
  verifyInstrument(signal?: AbortSignal): Promise<{
    verified: boolean;
    state: MarketDataProviderState;
    instrument: ProviderInstrument | null;
    reasonCode: string | null;
  }>;
  fetchCompletedCandles(
    request: FetchCompletedCandlesRequest
  ): Promise<FetchCompletedCandlesResult>;
}

/**
 * Redacts privileged tokens, Bearer headers, account IDs, and URL credentials from text
 * before storing in diagnostics, warnings, or error payloads.
 */
export function redactSensitiveText(
  input: string,
  secrets: ReadonlyArray<string | undefined | null> = []
): string {
  let sanitized = input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api_key|apikey|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:https?|postgres(?:ql)?):\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');

  for (const secret of secrets) {
    if (secret && secret.trim().length >= 4) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }
  return sanitized;
}

/**
 * Default zero-credential adapter for Stage 2A.
 * Always reports NOT_CONFIGURED and returns empty candle arrays — never synthetic or mock prices.
 */
export class NoProviderAdapter implements MarketDataAdapter {
  readonly adapterName = 'NoProviderAdapter';
  readonly alignmentPolicy: AlignmentPolicy;

  constructor(policy: AlignmentPolicy = DEFAULT_ALIGNMENT_POLICY) {
    this.alignmentPolicy = policy;
  }

  async getStatus(): Promise<AdapterStatusSnapshot> {
    return {
      adapterName: this.adapterName,
      providerVerified: false,
      instrument: null,
      quality: {
        state: 'NOT_CONFIGURED',
        lastSuccessfulRequestUtc: null,
        lastProviderCandleOpenUtc: null,
        lastCompleteCandleCloseUtc: null,
        freshnessSeconds: null,
        missingBarCount: null,
        duplicateBarCount: null,
        alignmentPolicy: this.alignmentPolicy,
        warnings: [],
        reasonCode: 'NO_PROVIDER_CONFIGURED',
      },
    };
  }

  async verifyInstrument() {
    return {
      verified: false,
      state: 'NOT_CONFIGURED' as const,
      instrument: null,
      reasonCode: 'NO_PROVIDER_CONFIGURED',
    };
  }

  async fetchCompletedCandles(): Promise<FetchCompletedCandlesResult> {
    return {
      status: 'NOT_CONFIGURED',
      candles: [],
      retrievedAtUtc: new Date().toISOString(),
      duplicateBarCount: 0,
      missingBarCount: 0,
      warnings: [],
      reasonCode: 'NO_PROVIDER_CONFIGURED',
    };
  }
}
