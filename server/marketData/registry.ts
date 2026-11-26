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
  adapter: MarketDataAdapter;
  store: CandleStore;
  historyPersistence: HistoryPersistenceState;
  backfillEnabled: boolean;
}

/**
 * Resolves the server-side Stage 2A market-data runtime strictly from server environment variables.
 * With zero credentials or MARKET_FEED_ENABLED=false, resolves strictly to NoProviderAdapter
 * and NOT_PERSISTENT history state.
 */
export function resolveMarketDataRuntime(
  env: Record<string, string | undefined> = process.env
): MarketDataRuntime {
  const gates = readFeatureGates(env);
  const providerChoice = (env.MARKET_DATA_PROVIDER ?? 'none')
    .trim()
    .toLowerCase();

  let adapter: MarketDataAdapter;
  if (gates.MARKET_FEED_ENABLED && providerChoice === 'oanda_v20') {
    const oandaConfig = parseOandaConfigFromEnv(env);
    adapter = new OandaV20MarketDataAdapter(oandaConfig);
  } else {
    adapter = new NoProviderAdapter();
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  const store: CandleStore = databaseUrl
    ? new PostgresCandleStore({ databaseUrl })
    : new InMemoryCandleStore();

  return {
    adapter,
    store,
    historyPersistence: store.getPersistenceState(),
    backfillEnabled: readBackfillEnabled(env),
  };
}
