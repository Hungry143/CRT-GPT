import {
  readBackfillEnabled,
  readFeatureGates,
} from '@/server/config/featureGates';
import { MarketDataIngestionWorker } from '@/server/marketData/ingestionWorker';
import {
  createMarketDataRuntime,
} from '@/server/marketData/registry';

async function main(): Promise<void> {
  const gates = readFeatureGates(process.env);
  const backfillEnabled = readBackfillEnabled(process.env);

  if (!gates.MARKET_FEED_ENABLED || !backfillEnabled) {
    console.log(
      JSON.stringify({
        event: 'ingestion_worker_disabled',
        marketFeedEnabled: gates.MARKET_FEED_ENABLED,
        backfillEnabled,
        reasonCode: 'LIVE_INGESTION_DISABLED',
      })
    );
    process.exit(0);
  }

  const runtime = createMarketDataRuntime(process.env);
  const worker = new MarketDataIngestionWorker({
    adapter: runtime.adapter,
    store: runtime.store,
    config: {
      marketFeedEnabled: gates.MARKET_FEED_ENABLED,
      backfillEnabled,
    },
  });

  const startRes = worker.start();
  if (!startRes.started) {
    console.log(
      JSON.stringify({
        event: 'ingestion_worker_not_started',
        reasonCode: startRes.reasonCode,
      })
    );
    await runtime.store.close();
    process.exit(0);
  }

  const shutdown = async () => {
    await worker.stop();
    await runtime.store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await worker.runCycleOnce();
}

void main();
