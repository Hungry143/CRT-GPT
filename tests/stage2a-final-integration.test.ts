import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildPgPoolConfig,
  createManagedPgExecutor,
} from '../server/db/postgres';
import { runPostgresMigrations } from '../server/db/migrations';
import {
  InMemoryCandleStore,
  PostgresCandleStore,
  type PgQueryExecutor,
} from '../server/marketData/candleStore';
import { buildFeedConfigIdentity } from '../server/marketData/feedCheckpoint';
import { MarketDataIngestionWorker } from '../server/marketData/ingestionWorker';
import {
  OandaV20MarketDataAdapter,
  type OandaV20Config,
} from '../server/marketData/oandaV20Adapter';
import {
  resetMarketDataRuntime,
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '../server/marketData/registry';
import { buildMarketCandlesPayload } from '../server/routes/marketCandles';
import { buildMarketSessionPayload } from '../server/routes/marketSession';
import { buildMarketStatusPayload } from '../server/routes/marketStatus';
import {
  createMarketClosurePolicy,
  createVerifiedProviderSchedule,
} from '../shared/utils/marketClosurePolicy';
import {
  buildSyntheticClosedCandles,
  buildSyntheticOandaRawPayload,
} from './fixtures/syntheticCandles';

const execFileAsync = promisify(execFile);

/**
 * Shared stateful SQL-emulating PostgreSQL backend representing a durable database
 * accessed by two completely independent processes (ingestion worker + API server).
 */
function createSharedPostgresMock() {
  const migrations = new Set<string>();
  const candles = new Map<string, Record<string, unknown>>();
  const revisions: Array<Record<string, unknown>> = [];
  const checkpoints = new Map<string, Record<string, unknown>>();

  const executor: PgQueryExecutor = {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[]
    ): Promise<{ rows: T[] }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (
        normalized.startsWith('CREATE TABLE') ||
        normalized.startsWith('CREATE INDEX') ||
        normalized.startsWith('ALTER TABLE')
      ) {
        return { rows: [] };
      }

      if (normalized.startsWith('SELECT version FROM schema_migrations')) {
        return {
          rows: Array.from(migrations)
            .sort()
            .map((version) => ({ version }) as unknown as T),
        };
      }

      if (normalized.startsWith('INSERT INTO schema_migrations')) {
        migrations.add(String(params[0]));
        return { rows: [] };
      }

      if (
        normalized.includes(
          'FROM normalized_candles WHERE source_candle_id = $1'
        )
      ) {
        const row = candles.get(String(params[0]));
        return { rows: row ? ([row] as unknown as T[]) : [] };
      }

      if (normalized.startsWith('INSERT INTO normalized_candles')) {
        candles.set(String(params[0]), {
          source_candle_id: params[0],
          provider: params[1],
          provider_symbol: params[2],
          granularity: params[3],
          price_basis: params[4],
          open_time_utc: params[5],
          close_time_utc: params[6],
          open_price: params[7],
          high_price: params[8],
          low_price: params[9],
          close_price: params[10],
          volume: params[11],
          complete: params[12],
          source_retrieved_at_utc: params[13],
          config_identity_hash: params[14] ?? 'legacy_unscoped',
          provider_env: params[15] ?? null,
          account_scope_hash: params[16] ?? null,
        });
        return { rows: [] };
      }

      if (normalized.includes('FROM normalized_candles WHERE complete = TRUE')) {
        const granularity = String(params[0]);
        const limit = Number(params[1]);
        const configIdMatch = /AND config_identity_hash = \$(\d+)/.exec(normalized);
        const providerMatch = /AND provider = \$(\d+)/.exec(normalized);
        const envMatch = /AND provider_env = \$(\d+)/.exec(normalized);
        const acctMatch = /AND account_scope_hash = \$(\d+)/.exec(normalized);
        const symbolMatch = /AND provider_symbol = \$(\d+)/.exec(normalized);
        const basisMatch = /AND price_basis = \$(\d+)/.exec(normalized);
        const configId = configIdMatch
          ? String(params[Number(configIdMatch[1]) - 1])
          : null;
        const provider = providerMatch
          ? String(params[Number(providerMatch[1]) - 1])
          : null;
        const providerEnv = envMatch
          ? String(params[Number(envMatch[1]) - 1])
          : null;
        const accountScopeHash = acctMatch
          ? String(params[Number(acctMatch[1]) - 1])
          : null;
        const providerSymbol = symbolMatch
          ? String(params[Number(symbolMatch[1]) - 1])
          : null;
        const priceBasis = basisMatch
          ? String(params[Number(basisMatch[1]) - 1])
          : null;

        const rows = Array.from(candles.values())
          .filter(
            (r) =>
              r.complete === true &&
              r.granularity === granularity &&
              (!configId || r.config_identity_hash === configId) &&
              (!provider || r.provider === provider) &&
              (!providerEnv || r.provider_env === providerEnv) &&
              (!accountScopeHash || r.account_scope_hash === accountScopeHash) &&
              (!providerSymbol || r.provider_symbol === providerSymbol) &&
              (!priceBasis || r.price_basis === priceBasis)
          )
          .sort(
            (a, b) =>
              Date.parse(String(b.open_time_utc)) -
              Date.parse(String(a.open_time_utc))
          )
          .slice(0, limit);
        return { rows: rows as unknown as T[] };
      }

      if (normalized.startsWith('INSERT INTO candle_revision_events')) {
        revisions.push({
          source_candle_id: params[0],
          detected_at_utc: params[1],
          changed_fields: params[2],
          previous_close: params[3],
          revised_close: params[4],
          config_identity_hash: params[5] ?? 'legacy_unscoped',
        });
        return { rows: [] };
      }

      if (normalized.includes('FROM candle_revision_events')) {
        return { rows: revisions as unknown as T[] };
      }

      if (normalized.startsWith('INSERT INTO market_feed_checkpoints')) {
        checkpoints.set(String(params[0]), {
          checkpoint_key: params[0],
          config_identity_hash: params[1],
          provider: params[2],
          price_basis: params[3],
          policy_version: params[4],
          adapter_name: params[5],
          provider_symbol: params[6],
          state: params[7],
          provider_verified: params[8],
          last_successful_request_utc: params[9],
          last_provider_candle_open_utc: params[10],
          last_complete_candle_close_utc: params[11],
          missing_bar_count: params[12],
          duplicate_bar_count: params[13],
          reason_code: params[14],
          warnings: params[15],
          updated_at_utc: params[16],
          provider_env: params[17] ?? null,
          account_scope_hash: params[18] ?? null,
        });
        return { rows: [] };
      }

      if (
        normalized.includes(
          'FROM market_feed_checkpoints WHERE checkpoint_key = $1'
        )
      ) {
        const row = checkpoints.get(String(params[0]));
        return { rows: row ? ([row] as unknown as T[]) : [] };
      }

      throw new Error(`Unhandled SQL: ${normalized}`);
    },
  };

  return { executor, candles, checkpoints, migrations };
}

function createTestVerifiedOandaUsSchedule() {
  return createVerifiedProviderSchedule({
    scheduleId: 'test-verified-oanda-us-xauusd-2026-2027',
    provenance: {
      provider: 'oanda_v20',
      division: 'OANDA_US',
      instrument: 'XAU_USD',
      verifiedBy: 'stage2b-test-fixture',
      verifiedSource: 'OANDA US metals holiday bulletin (test fixture)',
      verifiedAtUtc: '2026-01-02T00:00:00.000Z',
    },
    effectiveFromNyDate: '2026-01-01',
    effectiveToNyDate: '2027-12-31',
    fullDayHolidaysNy: ['2026-01-01', '2026-04-03', '2026-12-25'],
    specialSessions: [
      {
        nyDate: '2026-11-26',
        earlyCloseNy: { hour: 13, minute: 0 },
        reopenNy: { hour: 17, minute: 0 },
        label: 'Verified OANDA US Thanksgiving Early Close (13:00–17:00 NY)',
      },
    ],
  });
}

test('cross-process integration: standalone worker ingests XAUUSD candles and a separate fresh API runtime serves both /api/market/status and /api/market/candles', async () => {
  const sharedDb = createSharedPostgresMock();
  const dbUrl = 'postgresql://crt_worker:secret@127.0.0.1:5432/crt_shared';
  const closurePolicy = createTestVerifiedOandaUsSchedule();

  // Monday 2026-06-15 10:00Z .. 10:45Z (open market, 3 completed M15 bars)
  const nowUtc = new Date('2026-06-15T10:50:00.000Z');
  const bars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 3,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: nowUtc.toISOString(),
  });

  const oandaConfig: OandaV20Config = {
    env: 'practice',
    accountId: '101-001-7777777-001',
    apiToken: 'worker-secret-token-001',
    instrument: 'XAU_USD',
    maxRetries: 0,
    verifiedSchedule: closurePolicy,
  };

  // --- Process A: Standalone Ingestion Worker ---
  const workerStore = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: sharedDb.executor,
  });
  const workerAdapter = new OandaV20MarketDataAdapter(oandaConfig, {
    nowFn: () => nowUtc,
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes('/instruments?')) {
        return new Response(
          JSON.stringify({
            instruments: [
              { name: 'XAU_USD', displayPrecision: 3, pipLocation: -2 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify(buildSyntheticOandaRawPayload(bars, 'M15')),
        { status: 200 }
      );
    },
  });

  const sharedIdentity = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: oandaConfig.env,
    accountId: oandaConfig.accountId,
    providerSymbol: oandaConfig.instrument,
    priceBasis: workerAdapter.alignmentPolicy.priceBasis,
    policyVersion: workerAdapter.alignmentPolicy.policyVersion,
  });

  const worker = new MarketDataIngestionWorker({
    adapter: workerAdapter,
    store: workerStore,
    configIdentity: sharedIdentity,
    verifiedSchedule: closurePolicy,
    nowFn: () => nowUtc,
    config: {
      marketFeedEnabled: true,
      backfillEnabled: true,
      granularities: ['M15'],
      batchSize: 50,
    },
  });

  const cycle = await worker.runCycleOnce();
  assert.equal(cycle.status, 'COMPLETED');
  assert.equal(cycle.totalInserted, 3);

  // --- Process B: Fresh API Server Runtime (unpolled adapter, fresh store) ---
  // Note: freshApiAdapter has NEVER made an upstream HTTP call and starts in CONNECTING state!
  let apiUpstreamCalls = 0;
  const freshApiAdapter = new OandaV20MarketDataAdapter(oandaConfig, {
    nowFn: () => nowUtc,
    fetchFn: async () => {
      apiUpstreamCalls += 1;
      throw new Error('API process must read durable checkpoint + store, not hit upstream');
    },
  });
  const freshApiStore = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: sharedDb.executor,
  });
  const apiRuntime: MarketDataRuntime = {
    fingerprint: 'api-proc-fresh',
    configIdentity: sharedIdentity,
    closurePolicy,
    adapter: freshApiAdapter,
    store: freshApiStore,
    historyPersistence: freshApiStore.getPersistenceState(),
    backfillEnabled: false,
    marketFeedEnabled: true,
  };

  // Both status AND candles reconcile via the same durable identity-validated checkpoint!
  const statusPayload = await buildMarketStatusPayload(nowUtc, apiRuntime);
  assert.equal(statusPayload.historyPersistence, 'POSTGRES_CONNECTED');
  assert.equal(statusPayload.providerVerified, true);
  assert.equal(statusPayload.quality.state, 'CONNECTED');
  assert.equal(
    statusPayload.quality.lastCompleteCandleCloseUtc,
    bars[2].closeTimeUtc
  );

  const candlesPayload = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    nowUtc,
    apiRuntime
  );
  assert.equal(candlesPayload.status, 'CONNECTED');
  assert.equal(candlesPayload.count, 3);
  assert.equal(candlesPayload.data[0].openTimeUtc, bars[0].openTimeUtc);
  assert.equal(candlesPayload.data[2].closeTimeUtc, bars[2].closeTimeUtc);

  const sessionPayload = await buildMarketSessionPayload(nowUtc, apiRuntime);
  assert.equal(sessionPayload.session.expectedMarketScheduleState, 'OPEN_EXPECTED');
  assert.equal(sessionPayload.session.observedMarketAvailability, 'OBSERVED_ACTIVE');
  assert.equal(apiUpstreamCalls, 0);

  // Stale check on Process B (2 hours later during open market) fails closed on BOTH status and candles
  const staleNow = new Date('2026-06-15T12:50:00.000Z');
  const staleStatus = await buildMarketStatusPayload(staleNow, apiRuntime);
  assert.equal(staleStatus.quality.state, 'STALE');
  assert.equal(staleStatus.quality.reasonCode, 'FEED_DATA_STALE');

  const staleCandles = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    staleNow,
    apiRuntime
  );
  assert.equal(staleCandles.status, 'STALE');
  assert.equal(staleCandles.reasonCode, 'FEED_DATA_STALE');
  assert.equal(staleCandles.count, 0);
  assert.deepEqual(staleCandles.data, []);
});

test('checkpoint identity isolation rejects stale checkpoints from different provider, account, environment, or price basis', async () => {
  const sharedDb = createSharedPostgresMock();
  const dbUrl = 'postgresql://crt_worker:secret@127.0.0.1:5432/crt_shared';
  const nowUtc = new Date('2026-06-15T10:50:00.000Z');
  const closurePolicy = createTestVerifiedOandaUsSchedule();

  const bars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: nowUtc.toISOString(),
  });

  const identityA = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: 'practice',
    accountId: '101-001-ACCOUNT-AAA',
    providerSymbol: 'XAU_USD',
    priceBasis: 'MID',
    policyVersion: '2026.1-ny17-mid',
  });

  // Seed DB + checkpoint under Practice Account A, MID price basis
  const storeA = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: sharedDb.executor,
  });
  await storeA.ensureReady();
  await storeA.upsertCandles(bars, nowUtc.toISOString(), {
    configIdentityHash: identityA.configIdentityHash,
    providerEnv: identityA.providerEnv,
    accountScopeHash: identityA.accountScopeHash,
  });

  await storeA.saveFeedCheckpoint({
    checkpointKey: 'XAUUSD:primary',
    configIdentityHash: identityA.configIdentityHash,
    provider: identityA.provider,
    priceBasis: identityA.priceBasis,
    policyVersion: identityA.policyVersion,
    adapterName: 'OandaV20MarketDataAdapter',
    providerSymbol: 'XAU_USD',
    state: 'CONNECTED',
    providerVerified: true,
    lastSuccessfulRequestUtc: nowUtc.toISOString(),
    lastProviderCandleOpenUtc: bars[1].openTimeUtc,
    lastCompleteCandleCloseUtc: bars[1].closeTimeUtc,
    missingBarCount: 0,
    duplicateBarCount: 0,
    reasonCode: null,
    warnings: [],
    updatedAtUtc: nowUtc.toISOString(),
  });

  const mismatchedIdentities = [
    {
      label: 'different account ID',
      identity: buildFeedConfigIdentity({
        provider: 'oanda_v20',
        providerEnv: 'practice',
        accountId: '101-001-ACCOUNT-BBB',
        providerSymbol: 'XAU_USD',
        priceBasis: 'MID',
        policyVersion: '2026.1-ny17-mid',
      }),
    },
    {
      label: 'different environment (live vs practice)',
      identity: buildFeedConfigIdentity({
        provider: 'oanda_v20',
        providerEnv: 'live',
        accountId: '101-001-ACCOUNT-AAA',
        providerSymbol: 'XAU_USD',
        priceBasis: 'MID',
        policyVersion: '2026.1-ny17-mid',
      }),
    },
    {
      label: 'different price basis (BID vs MID)',
      identity: buildFeedConfigIdentity({
        provider: 'oanda_v20',
        providerEnv: 'practice',
        accountId: '101-001-ACCOUNT-AAA',
        providerSymbol: 'XAU_USD',
        priceBasis: 'BID',
        policyVersion: '2026.1-ny17-mid',
      }),
    },
    {
      label: 'different provider',
      identity: buildFeedConfigIdentity({
        provider: 'other_provider',
        providerEnv: 'practice',
        accountId: '101-001-ACCOUNT-AAA',
        providerSymbol: 'XAU_USD',
        priceBasis: 'MID',
        policyVersion: '2026.1-ny17-mid',
      }),
    },
  ];

  for (const scenario of mismatchedIdentities) {
    const adapter = new OandaV20MarketDataAdapter({
      env: 'practice',
      accountId: '101-001-ACCOUNT-BBB',
      apiToken: 'token-mismatch-check',
      instrument: 'XAU_USD',
      verifiedSchedule: closurePolicy,
    });
    const runtime: MarketDataRuntime = {
      fingerprint: `mismatch-${scenario.label}`,
      configIdentity: scenario.identity,
      closurePolicy,
      adapter,
      store: new PostgresCandleStore({
        databaseUrl: dbUrl,
        executor: sharedDb.executor,
      }),
      historyPersistence: 'POSTGRES_CONNECTED',
      backfillEnabled: false,
      marketFeedEnabled: true,
    };

    const status = await buildMarketStatusPayload(nowUtc, runtime);
    assert.equal(
      status.quality.state,
      'CONNECTING',
      `${scenario.label} must NOT treat stale checkpoint as CONNECTED`
    );
    assert.equal(status.providerVerified, false);
    assert.ok(
      status.quality.warnings.some((w) =>
        w.includes('different provider, account, symbol, or price-basis')
      ),
      `${scenario.label} should surface identity mismatch warning`
    );

    const candles = await buildMarketCandlesPayload(
      { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
      nowUtc,
      runtime
    );
    assert.equal(candles.status, 'CONNECTING');
    assert.equal(candles.count, 0);
    assert.deepEqual(candles.data, []);
  }
});

test('authoritative market-session closure policy handles weekends, holidays, special hours, and fails closed on unknown closures without permanently rejecting valid history', async () => {
  const policy = createTestVerifiedOandaUsSchedule();

  // 1. Weekend closure: Sat 2026-06-20 12:00 UTC
  assert.equal(
    policy.inspectInstant(new Date('2026-06-20T12:00:00.000Z')).state,
    'WEEKEND_CLOSED'
  );
  // 2. Full-day holiday: Christmas 2026-12-25 15:00 UTC (10:00 EST)
  assert.equal(
    policy.inspectInstant(new Date('2026-12-25T15:00:00.000Z')).state,
    'HOLIDAY_CLOSED'
  );
  // 3. Special early-close trading hours: Thanksgiving 2026-11-26 (early close 13:00 EST = 18:00 UTC)
  assert.equal(
    policy.inspectInstant(new Date('2026-11-26T17:30:00.000Z')).state, // 12:30 EST -> OPEN
    'OPEN_EXPECTED'
  );
  assert.equal(
    policy.inspectInstant(new Date('2026-11-26T18:15:00.000Z')).state, // 13:15 EST -> CLOSED
    'HOLIDAY_CLOSED'
  );
  // 4. Out-of-coverage date -> UNKNOWN (never silently assumes open)
  assert.equal(
    policy.inspectInstant(new Date('2032-06-15T14:00:00.000Z')).state,
    'UNKNOWN'
  );

  // 5. Special trading hours gap (Thanksgiving early close 13:00 EST -> next open 17:00 EST = 22:00Z)
  // Last open H1 bar before early close: 17:00Z..18:00Z (12:00..13:00 EST).
  // Next open H1 bar after daily roll: 22:00Z..23:00Z (17:00..18:00 EST).
  const preEarlyClose = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-11-26T17:00:00.000Z',
    count: 1,
    granularity: 'H1',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-11-26T23:10:00.000Z',
  })[0];
  const postEarlyClose = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-11-26T22:00:00.000Z',
    count: 1,
    granularity: 'H1',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-11-26T23:10:00.000Z',
  })[0];

  const oandaConfig: OandaV20Config = {
    env: 'practice',
    accountId: '101-001-8888888-001',
    apiToken: 'token-closure-test',
    instrument: 'XAU_USD',
    verifiedSchedule: policy,
  };
  const identity = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: 'practice',
    accountId: oandaConfig.accountId,
    providerSymbol: 'XAU_USD',
    priceBasis: 'MID',
    policyVersion: '2026.1-ny17-mid',
  });

  const sharedDb = createSharedPostgresMock();
  const dbUrl = 'postgresql://crt_worker:secret@127.0.0.1:5432/crt_closure';
  const store = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: sharedDb.executor,
  });
  await store.ensureReady();
  await store.upsertCandles([preEarlyClose, postEarlyClose], '2026-11-26T23:10:00.000Z', {
    configIdentityHash: identity.configIdentityHash,
    providerEnv: identity.providerEnv,
    accountScopeHash: identity.accountScopeHash,
  });
  await store.saveFeedCheckpoint({
    checkpointKey: 'XAUUSD:primary',
    configIdentityHash: identity.configIdentityHash,
    provider: identity.provider,
    priceBasis: identity.priceBasis,
    policyVersion: identity.policyVersion,
    adapterName: 'OandaV20MarketDataAdapter',
    providerSymbol: 'XAU_USD',
    state: 'CONNECTED',
    providerVerified: true,
    lastSuccessfulRequestUtc: '2026-11-26T23:10:00.000Z',
    lastProviderCandleOpenUtc: postEarlyClose.openTimeUtc,
    lastCompleteCandleCloseUtc: postEarlyClose.closeTimeUtc,
    missingBarCount: 0,
    duplicateBarCount: 0,
    reasonCode: null,
    warnings: [],
    updatedAtUtc: '2026-11-26T23:10:00.000Z',
  });

  const runtime: MarketDataRuntime = {
    fingerprint: 'closure-test',
    configIdentity: identity,
    closurePolicy: policy,
    adapter: new OandaV20MarketDataAdapter(oandaConfig),
    store,
    historyPersistence: 'POSTGRES_CONNECTED',
    backfillEnabled: false,
    marketFeedEnabled: true,
  };

  // With authoritative policy covering Thanksgiving early close -> 2 valid bars served cleanly!
  const earlyCloseRes = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'H1', limit: 10 },
    new Date('2026-11-26T23:10:00.000Z'),
    runtime
  );
  assert.equal(earlyCloseRes.status, 'CONNECTED');
  assert.equal(earlyCloseRes.count, 2);

  // 6. Unknown closure (unlisted halt on 2026-06-16 10:15Z..10:45Z):
  // Worker encounters unknown gap -> fails closed (DEGRADED/STALE), YET preserves valid historical candles
  // so subsequent contiguous bars recover cleanly and valid history is NEVER permanently lost!
  const preUnknownBar = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-16T10:00:00.000Z',
    count: 1,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-16T11:05:00.000Z',
  })[0];
  const postUnknownBars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-16T10:45:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-16T11:20:00.000Z',
  });

  let phase: 'UNKNOWN_GAP' | 'RECOVERED' = 'UNKNOWN_GAP';
  let currentNow = new Date('2026-06-16T11:05:00.000Z');
  const recoveryStore = new InMemoryCandleStore();
  const recoveryAdapter = new OandaV20MarketDataAdapter(
    { ...oandaConfig, maxRetries: 0 },
    {
      nowFn: () => currentNow,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('/instruments?')) {
          return new Response(
            JSON.stringify({
              instruments: [
                { name: 'XAU_USD', displayPrecision: 3, pipLocation: -2 },
              ],
            }),
            { status: 200 }
          );
        }
        if (phase === 'UNKNOWN_GAP') {
          return new Response(
            JSON.stringify(
              buildSyntheticOandaRawPayload(
                [preUnknownBar, postUnknownBars[0]],
                'M15'
              )
            ),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify(buildSyntheticOandaRawPayload(postUnknownBars, 'M15')),
          { status: 200 }
        );
      },
    }
  );

  const recoveryWorker = new MarketDataIngestionWorker({
    adapter: recoveryAdapter,
    store: recoveryStore,
    configIdentity: identity,
    verifiedSchedule: policy,
    nowFn: () => currentNow,
    config: {
      marketFeedEnabled: true,
      backfillEnabled: true,
      granularities: ['M15'],
    },
  });

  // Step A: Unknown closure gap fails closed on worker & checkpoint, while preserving valid bars in store
  const gapCycle = await recoveryWorker.runCycleOnce();
  assert.equal(gapCycle.status, 'DEGRADED');
  assert.equal(gapCycle.reasonCode, 'UNEXPECTED_BAR_GAP');
  assert.equal(gapCycle.totalInserted, 2); // valid pre + post bars preserved in durable store!

  const runtimeDuringGap: MarketDataRuntime = {
    fingerprint: 'unknown-closure',
    configIdentity: identity,
    closurePolicy: policy,
    adapter: new OandaV20MarketDataAdapter(oandaConfig),
    store: recoveryStore,
    historyPersistence: 'NOT_PERSISTENT',
    backfillEnabled: false,
    marketFeedEnabled: true,
  };
  const duringGapCandles = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    currentNow,
    runtimeDuringGap
  );
  assert.equal(duringGapCandles.status, 'STALE');
  assert.equal(duringGapCandles.count, 0);

  // Step B: Market reopens with contiguous bars -> worker recovers checkpoint to CONNECTED!
  phase = 'RECOVERED';
  currentNow = new Date('2026-06-16T11:20:00.000Z');
  const recoveredCycle = await recoveryWorker.runCycleOnce();
  assert.equal(recoveredCycle.status, 'COMPLETED');
  assert.equal(recoveredCycle.totalInserted, 1);

  // Contiguous post-closure tail (limit=2) is immediately serveable!
  const recoveredTail = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 2 },
    currentNow,
    runtimeDuringGap
  );
  assert.equal(recoveredTail.status, 'CONNECTED');
  assert.equal(recoveredTail.count, 2);

  // Cross-gap query STILL fails closed while closure is unknown...
  const crossGapUnknown = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    currentNow,
    runtimeDuringGap
  );
  assert.equal(crossGapUnknown.status, 'STALE');
  assert.equal(crossGapUnknown.reasonCode, 'UNEXPECTED_BAR_GAP');

  // ...and once the explicit closure is codified in the authoritative policy, ALL 3 historical bars validate immediately with zero re-ingestion!
  const updatedPolicy = createMarketClosurePolicy({
    ...policy.config,
    explicitClosuresUtc: [
      {
        startUtc: '2026-06-16T10:15:00.000Z',
        endUtc: '2026-06-16T10:45:00.000Z',
        kind: 'HOLIDAY_CLOSED',
        label: 'Verified liquidity provider maintenance halt',
      },
    ],
  });
  const codifiedFullHistory = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    currentNow,
    { ...runtimeDuringGap, closurePolicy: updatedPolicy }
  );
  assert.equal(codifiedFullHistory.status, 'CONNECTED');
  assert.equal(codifiedFullHistory.count, 3);
});

test('standalone ingestion worker stays alive periodically when enabled, never overlaps cycles, drains cleanly on stop(), and exits cleanly when disabled', async () => {
  const store = new InMemoryCandleStore();
  let currentConcurrency = 0;
  let maxConcurrency = 0;
  let cyclesStarted = 0;

  const bars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-15T10:35:00.000Z',
  });

  const mockAdapter = {
    adapterName: 'MockPeriodicAdapter',
    alignmentPolicy: new OandaV20MarketDataAdapter(null).alignmentPolicy,
    getStatus: async () => ({
      adapterName: 'MockPeriodicAdapter',
      providerVerified: true,
      instrument: {
        displaySymbol: 'XAUUSD' as const,
        providerName: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        pricePrecision: 3,
        pipLocation: -2,
        verified: true,
        verifiedAtUtc: '2026-06-15T10:35:00.000Z',
      },
      quality: {
        state: 'CONNECTED' as const,
        lastSuccessfulRequestUtc: '2026-06-15T10:35:00.000Z',
        lastProviderCandleOpenUtc: bars[1].openTimeUtc,
        lastCompleteCandleCloseUtc: bars[1].closeTimeUtc,
        freshnessSeconds: 300,
        missingBarCount: 0,
        duplicateBarCount: 0,
        alignmentPolicy: new OandaV20MarketDataAdapter(null).alignmentPolicy,
        warnings: [],
        reasonCode: null,
      },
    }),
    verifyInstrument: async () => ({
      verified: true,
      state: 'CONNECTED' as const,
      instrument: null,
      reasonCode: null,
    }),
    fetchCompletedCandles: async () => {
      cyclesStarted += 1;
      currentConcurrency += 1;
      maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
      await new Promise((r) => setTimeout(r, 25));
      currentConcurrency -= 1;
      return {
        status: 'CONNECTED' as const,
        candles: bars,
        retrievedAtUtc: '2026-06-15T10:35:00.000Z',
        duplicateBarCount: 0,
        missingBarCount: 0,
        warnings: [],
        reasonCode: null,
      };
    },
  };

  const worker = new MarketDataIngestionWorker({
    adapter: mockAdapter,
    store,
    nowFn: () => new Date('2026-06-15T10:35:00.000Z'),
    config: {
      marketFeedEnabled: true,
      backfillEnabled: true,
      granularities: ['M15'],
      pollIntervalMs: 20,
      allowFastIntervalForTests: true,
      keepProcessAlive: true,
    },
  });

  const started = worker.start({ runImmediately: true });
  assert.equal(started.started, true);
  assert.equal(worker.getStats().running, true);

  // Wait for at least 3 periodic cycles to complete
  const deadline = Date.now() + 2000;
  while (worker.getStats().cyclesCompleted < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }

  assert.ok(
    worker.getStats().cyclesCompleted >= 3,
    `Expected >= 3 periodic cycles, got ${worker.getStats().cyclesCompleted}`
  );
  assert.equal(maxConcurrency, 1, 'Periodic cycles must NEVER overlap');
  assert.ok(cyclesStarted >= 3);

  // Clean shutdown drains any active cycle and resolves waitUntilStopped()
  const stoppedPromise = worker.waitUntilStopped();
  await worker.stop();
  await stoppedPromise;

  assert.equal(worker.getStats().running, false);
  assert.equal(worker.getStats().inFlight, false);

  // Standalone CLI script exits 0 cleanly when live flags are disabled (default)
  const { stdout } = await execFileAsync(
    'npx',
    ['--yes', 'tsx', 'scripts/ingestion-worker.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MARKET_FEED_ENABLED: 'false',
        BACKFILL_ENABLED: 'false',
      },
    }
  );
  const cliEvent = JSON.parse(stdout.trim());
  assert.equal(cliEvent.event, 'ingestion_worker_disabled');
  assert.equal(cliEvent.reasonCode, 'LIVE_INGESTION_DISABLED');
});

test('runtime restart preserves durable status and candles without losing state', async () => {
  await resetMarketDataRuntime();

  const envConfig = {
    MARKET_FEED_ENABLED: 'false',
    BACKFILL_ENABLED: 'false',
    MARKET_DATA_PROVIDER: 'none',
  };
  const beforeRestart = resolveMarketDataRuntime(envConfig);
  await resetMarketDataRuntime();
  const afterRestart = resolveMarketDataRuntime(envConfig);

  assert.notStrictEqual(beforeRestart, afterRestart);
  assert.equal(afterRestart.adapter.adapterName, 'NoProviderAdapter');
  assert.equal(afterRestart.historyPersistence, 'NOT_PERSISTENT');

  await resetMarketDataRuntime();
});

test('PostgreSQL TLS certificate validation is enforced strictly in production and rejects insecure downgrades', () => {
  const remoteUrl = 'postgresql://crt_app:secret@db.prod.example.com:5432/crt';
  const remoteRequireUrl =
    'postgresql://crt_app:secret@db.prod.example.com:5432/crt?sslmode=require';
  const remoteNoVerifyUrl =
    'postgresql://crt_app:secret@db.prod.example.com:5432/crt?sslmode=no-verify';
  const remoteDisableUrl =
    'postgresql://crt_app:secret@db.prod.example.com:5432/crt?sslmode=disable';
  const localUrl = 'postgresql://crt_ci:secret@127.0.0.1:5432/crt_test';

  // 1. Production remote host without sslmode -> strict TLS with rejectUnauthorized: true
  const prodDefault = buildPgPoolConfig(remoteUrl, { NODE_ENV: 'production' });
  assert.deepEqual(prodDefault.ssl, { rejectUnauthorized: true });

  // 2. Production sslmode=require -> MUST enforce rejectUnauthorized: true and strip sslmode from connectionString
  const prodRequire = buildPgPoolConfig(remoteRequireUrl, {
    NODE_ENV: 'production',
  });
  assert.deepEqual(prodRequire.ssl, { rejectUnauthorized: true });
  assert.equal(prodRequire.connectionString?.includes('sslmode='), false);

  // 3. Production custom CA cert preserves rejectUnauthorized: true and passes PEM newlines
  const prodWithCa = buildPgPoolConfig(remoteRequireUrl, {
    NODE_ENV: 'production',
    DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----',
  });
  assert.deepEqual(prodWithCa.ssl, {
    rejectUnauthorized: true,
    ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
  });

  // 4. Production forbids sslmode=no-verify, DATABASE_SSL_REJECT_UNAUTHORIZED=false, and remote sslmode=disable
  assert.throws(
    () => buildPgPoolConfig(remoteNoVerifyUrl, { NODE_ENV: 'production' }),
    /forbidden in production/i
  );
  assert.throws(
    () =>
      buildPgPoolConfig(remoteUrl, {
        NODE_ENV: 'production',
        DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
      }),
    /forbidden in production/i
  );
  assert.throws(
    () => buildPgPoolConfig(remoteDisableUrl, { NODE_ENV: 'production' }),
    /forbidden in production/i
  );

  // 5. Non-production sslmode=require ALSO defaults to rejectUnauthorized: true (never silent downgrade)
  const devRequire = buildPgPoolConfig(remoteRequireUrl, {
    NODE_ENV: 'development',
  });
  assert.deepEqual(devRequire.ssl, { rejectUnauthorized: true });

  // 6. Non-production loopback without sslmode works cleanly for local/CI Postgres
  const ciLocal = buildPgPoolConfig(localUrl, { NODE_ENV: 'test' });
  assert.equal(ciLocal.ssl, undefined);
});

// Live PostgreSQL cross-process test executed automatically in CI when TEST_DATABASE_URL is configured
const liveTestDbUrl = process.env.TEST_DATABASE_URL?.trim();
test(
  'live PostgreSQL cross-process worker-to-API candle serving and identity check (runs when TEST_DATABASE_URL is set)',
  { skip: !liveTestDbUrl },
  async () => {
    const executor = createManagedPgExecutor(liveTestDbUrl!);
    const closurePolicy = createTestVerifiedOandaUsSchedule();
    const nowUtc = new Date('2026-06-15T10:50:00.000Z');
    const bars = buildSyntheticClosedCandles({
      startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
      count: 3,
      granularity: 'M15',
      provider: 'oanda_v20',
      providerSymbol: 'XAU_USD',
      retrievedAtUtc: nowUtc.toISOString(),
    });

    try {
      await runPostgresMigrations(executor);
      const workerStore = new PostgresCandleStore({ databaseUrl: liveTestDbUrl });
      const apiStore = new PostgresCandleStore({ databaseUrl: liveTestDbUrl });

      try {
        const oandaConfig: OandaV20Config = {
          env: 'practice',
          accountId: '101-001-CI-PG-TEST',
          apiToken: 'ci-pg-secret-token',
          instrument: 'XAU_USD',
          verifiedSchedule: closurePolicy,
        };
        const identity = buildFeedConfigIdentity({
          provider: 'oanda_v20',
          providerEnv: 'practice',
          accountId: oandaConfig.accountId,
          providerSymbol: 'XAU_USD',
          priceBasis: 'MID',
          policyVersion: '2026.1-ny17-mid',
        });

        await workerStore.ensureReady();
        await workerStore.upsertCandles(bars, nowUtc.toISOString(), {
          configIdentityHash: identity.configIdentityHash,
          providerEnv: identity.providerEnv,
          accountScopeHash: identity.accountScopeHash,
        });
        await workerStore.saveFeedCheckpoint({
          checkpointKey: 'XAUUSD:primary',
          configIdentityHash: identity.configIdentityHash,
          provider: identity.provider,
          providerEnv: identity.providerEnv,
          accountScopeHash: identity.accountScopeHash,
          priceBasis: identity.priceBasis,
          policyVersion: identity.policyVersion,
          adapterName: 'OandaV20MarketDataAdapter',
          providerSymbol: 'XAU_USD',
          state: 'CONNECTED',
          providerVerified: true,
          lastSuccessfulRequestUtc: nowUtc.toISOString(),
          lastProviderCandleOpenUtc: bars[2].openTimeUtc,
          lastCompleteCandleCloseUtc: bars[2].closeTimeUtc,
          missingBarCount: 0,
          duplicateBarCount: 0,
          reasonCode: null,
          warnings: [],
          updatedAtUtc: nowUtc.toISOString(),
        });

        const apiRuntime: MarketDataRuntime = {
          fingerprint: 'ci-live-pg-api',
          configIdentity: identity,
          closurePolicy,
          adapter: new OandaV20MarketDataAdapter(oandaConfig),
          store: apiStore,
          historyPersistence: 'POSTGRES_CONFIGURED',
          backfillEnabled: false,
          marketFeedEnabled: true,
        };

        const status = await buildMarketStatusPayload(nowUtc, apiRuntime);
        assert.equal(status.historyPersistence, 'POSTGRES_CONNECTED');
        assert.equal(status.quality.state, 'CONNECTED');

        const candles = await buildMarketCandlesPayload(
          { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
          nowUtc,
          apiRuntime
        );
        assert.equal(candles.status, 'CONNECTED');
        assert.equal(candles.count, 3);
      } finally {
        await workerStore.close();
        await apiStore.close();
      }
    } finally {
      await executor.close();
    }
  }
);
