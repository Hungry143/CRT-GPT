import { createHash } from 'node:crypto';
import {
  readBackfillEnabled,
  readFeatureGates,
} from '@/server/config/featureGates';
import {
  NoProviderAdapter,
  type MarketDataAdapter,
} from '@/server/marketData/adapter';
import {
  InMemoryCandleStore,
  PostgresCandleStore,
  type CandleStore,
} from '@/server/marketData/candleStore';
import {
  OandaV20MarketDataAdapter,
  parseOandaConfigFromEnv,
} from '@/server/marketData/oandaV20Adapter';
import type { HistoryPersistenceState } from '@/shared/contracts/marketData';

export interface MarketDataRuntime {
  readonly fingerprint: string;
  adapter: MarketDataAdapter;
  store: CandleStore;
  historyPersistence: HistoryPersistenceState;
  backfillEnabled: boolean;
  marketFeedEnabled: boolean;
  staleThresholdSeconds?: number;
}

interface RuntimeCacheEntry {
  fingerprint: string;
  runtime: MarketDataRuntime;
}

const RUNTIME_CACHE_SYMBOL = Symbol.for(
  'crt.intelligence.stage2a.marketDataRuntimeCache'
);

type GlobalWithRuntimeCache = typeof globalThis & {
  [RUNTIME_CACHE_SYMBOL]?: Map<string, RuntimeCacheEntry>;
};

const MAX_CACHED_RUNTIMES = 8;

function getRuntimeCache(): Map<string, RuntimeCacheEntry> {
  const g = globalThis as GlobalWithRuntimeCache;
  if (!g[RUNTIME_CACHE_SYMBOL]) {
    g[RUNTIME_CACHE_SYMBOL] = new Map<string, RuntimeCacheEntry>();
  }
  return g[RUNTIME_CACHE_SYMBOL];
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const val = Number(raw.trim());
  return val > 0 ? val : undefined;
}

/**
 * Computes a one-way SHA-256 fingerprint of server market-data configuration.
 * Never exposes raw secrets while guaranteeing identical env configs reuse the exact
 * same MarketDataAdapter and CandleStore instances across HTTP requests.
 */
export function computeMarketDataEnvFingerprint(
  env: Record<string, string | undefined>
): string {
  const canonical = JSON.stringify({
    marketFeedEnabled: env.MARKET_FEED_ENABLED ?? '',
    backfillEnabled: env.BACKFILL_ENABLED ?? '',
    provider: env.MARKET_DATA_PROVIDER ?? 'none',
    oandaEnv: env.OANDA_ENV ?? '',
    oandaAccountId: env.OANDA_ACCOUNT_ID ?? '',
    oandaApiToken: env.OANDA_API_TOKEN ?? '',
    oandaInstrument: env.OANDA_INSTRUMENT ?? '',
    databaseUrl: env.DATABASE_URL ?? '',
    staleThresholdSeconds: env.MARKET_STALE_THRESHOLD_SECONDS ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Constructs a fresh, uncached MarketDataRuntime (useful for isolated tests and standalone workers).
 */
export function createMarketDataRuntime(
  env: Record<string, string | undefined> = process.env
): MarketDataRuntime {
  const gates = readFeatureGates(env);
  const providerChoice = (env.MARKET_DATA_PROVIDER ?? 'none')
    .trim()
    .toLowerCase();
  const staleThresholdSeconds = parseOptionalPositiveInt(
    env.MARKET_STALE_THRESHOLD_SECONDS
  );

  let adapter: MarketDataAdapter;
  if (gates.MARKET_FEED_ENABLED && providerChoice === 'oanda_v20') {
    const oandaConfig = parseOandaConfigFromEnv(env);
    adapter = new OandaV20MarketDataAdapter(
      oandaConfig
        ? {
            ...oandaConfig,
            ...(staleThresholdSeconds !== undefined
              ? { staleThresholdSeconds }
              : {}),
          }
        : null
    );
  } else {
    adapter = new NoProviderAdapter();
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  const store: CandleStore = databaseUrl
    ? new PostgresCandleStore({ databaseUrl })
    : new InMemoryCandleStore();

  return {
    fingerprint: computeMarketDataEnvFingerprint(env),
    adapter,
    store,
    historyPersistence: store.getPersistenceState(),
    backfillEnabled: readBackfillEnabled(env),
    marketFeedEnabled: gates.MARKET_FEED_ENABLED,
    staleThresholdSeconds,
  };
}

/**
 * Resolves the process-scoped Stage 2A market-data runtime singleton keyed by config fingerprint.
 * Fixes per-request MarketDataAdapter & CandleStore state resets across API routes while
 * safely defaulting to NoProviderAdapter + NOT_PERSISTENT when unconfigured.
 */
export function resolveMarketDataRuntime(
  env: Record<string, string | undefined> = process.env
): MarketDataRuntime {
  const fingerprint = computeMarketDataEnvFingerprint(env);
  const cache = getRuntimeCache();
  const existing = cache.get(fingerprint);
  if (existing) {
    return existing.runtime;
  }

  // Bound cache size and close evicted pools cleanly
  if (cache.size >= MAX_CACHED_RUNTIMES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      const evicted = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (evicted) {
        void evicted.runtime.store.close();
      }
    }
  }

  const runtime = createMarketDataRuntime(env);
  cache.set(fingerprint, { fingerprint, runtime });
  return runtime;
}

/**
 * Closes all cached database pools and clears the process-scoped runtime registry.
 * Intended for graceful worker shutdown and test cleanup.
 */
export async function resetMarketDataRuntime(): Promise<void> {
  const cache = getRuntimeCache();
  const entries = Array.from(cache.values());
  cache.clear();
  await Promise.all(entries.map((entry) => entry.runtime.store.close()));
}
