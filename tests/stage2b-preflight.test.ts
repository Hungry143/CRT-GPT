import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  STAGE_2A_MIGRATIONS,
  runPostgresMigrations,
} from '../server/db/migrations';
import { createManagedPgExecutor } from '../server/db/postgres';
import {
  InMemoryCandleStore,
  LEGACY_UNSCOPED_CONFIG_IDENTITY,
  PostgresCandleStore,
  buildScopedCheckpointKey,
  type PgQueryExecutor,
} from '../server/marketData/candleStore';
import { buildFeedConfigIdentity } from '../server/marketData/feedCheckpoint';
import { MarketDataIngestionWorker } from '../server/marketData/ingestionWorker';
import {
  OANDA_PRACTICE_SMOKE_GRANULARITIES,
  runOandaPracticeSmokeTest,
} from '../server/marketData/oandaPracticeSmoke';
import {
  OandaV20MarketDataAdapter,
  type OandaV20Config,
} from '../server/marketData/oandaV20Adapter';
import {
  createMarketDataRuntime,
  type MarketDataRuntime,
} from '../server/marketData/registry';
import { buildMarketCandlesPayload } from '../server/routes/marketCandles';
import { buildMarketSessionPayload } from '../server/routes/marketSession';
import { buildMarketStatusPayload } from '../server/routes/marketStatus';
import {
  createVerifiedProviderSchedule,
  resolveVerifiedScheduleForScope,
} from '../shared/utils/marketClosurePolicy';
import { validateCandleSeries } from '../shared/utils/candleValidator';
import { evaluateFeedStatusFreshness } from '../shared/utils/feedIntegrity';
import {
  buildSyntheticClosedCandles,
  buildSyntheticOandaRawPayload,
} from './fixtures/syntheticCandles';

const execFileAsync = promisify(execFile);

/**
 * Constraint-enforcing SQL-emulating PostgreSQL mock that explicitly models:
 * - Pre-003 legacy table constraint (`normalized_candles_natural_key`)
 * - Post-003 scoped constraint (`normalized_candles_scoped_natural_key`)
 * - Legacy row backfill with `config_identity_hash = 'legacy_unscoped'`
 */
function createMigrationAwarePostgresMock() {
  const migrations = new Set<string>();
  const candles = new Map<string, Record<string, unknown>>();
  const revisions: Array<Record<string, unknown>> = [];
  const checkpoints = new Map<string, Record<string, unknown>>();
  let hasLegacyNaturalConstraint = true;
  let hasScopedNaturalConstraint = false;

  const executor: PgQueryExecutor = {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[]
    ): Promise<{ rows: T[] }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
        return { rows: [] };
      }

      if (normalized.startsWith('ALTER TABLE normalized_candles')) {
        if (normalized.includes('ADD COLUMN IF NOT EXISTS config_identity_hash')) {
          for (const row of candles.values()) {
            if (!row.config_identity_hash) {
              row.config_identity_hash = LEGACY_UNSCOPED_CONFIG_IDENTITY;
            }
            if (row.provider_env === undefined) row.provider_env = null;
            if (row.account_scope_hash === undefined) row.account_scope_hash = null;
          }
        }
        if (normalized.includes('DROP CONSTRAINT IF EXISTS normalized_candles_natural_key')) {
          hasLegacyNaturalConstraint = false;
        }
        if (normalized.includes('DROP CONSTRAINT IF EXISTS normalized_candles_scoped_natural_key')) {
          hasScopedNaturalConstraint = false;
        }
        if (normalized.includes('ADD CONSTRAINT normalized_candles_scoped_natural_key')) {
          hasScopedNaturalConstraint = true;
        }
        return { rows: [] };
      }

      if (normalized.startsWith('ALTER TABLE')) {
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

      if (normalized.includes('FROM normalized_candles WHERE source_candle_id = $1')) {
        const row = candles.get(String(params[0]));
        return { rows: row ? ([row] as unknown as T[]) : [] };
      }

      if (normalized.startsWith('INSERT INTO normalized_candles')) {
        const sourceId = String(params[0]);
        const newRow: Record<string, unknown> = {
          source_candle_id: sourceId,
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
          config_identity_hash: params[14] ?? LEGACY_UNSCOPED_CONFIG_IDENTITY,
          provider_env: params[15] ?? null,
          account_scope_hash: params[16] ?? null,
        };

        // Enforce unique natural keys just like PostgreSQL
        for (const [existingId, existing] of candles.entries()) {
          if (existingId === sourceId) continue;
          const sameBaseKey =
            existing.provider === newRow.provider &&
            existing.provider_symbol === newRow.provider_symbol &&
            existing.price_basis === newRow.price_basis &&
            existing.granularity === newRow.granularity &&
            existing.open_time_utc === newRow.open_time_utc;

          if (hasLegacyNaturalConstraint && sameBaseKey) {
            throw new Error(
              'duplicate key value violates unique constraint "normalized_candles_natural_key"'
            );
          }
          if (
            hasScopedNaturalConstraint &&
            sameBaseKey &&
            existing.config_identity_hash === newRow.config_identity_hash
          ) {
            throw new Error(
              'duplicate key value violates unique constraint "normalized_candles_scoped_natural_key"'
            );
          }
        }

        candles.set(sourceId, newRow);
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

        const configId = configIdMatch ? String(params[Number(configIdMatch[1]) - 1]) : null;
        const provider = providerMatch ? String(params[Number(providerMatch[1]) - 1]) : null;
        const providerEnv = envMatch ? String(params[Number(envMatch[1]) - 1]) : null;
        const accountScopeHash = acctMatch ? String(params[Number(acctMatch[1]) - 1]) : null;
        const providerSymbol = symbolMatch ? String(params[Number(symbolMatch[1]) - 1]) : null;
        const priceBasis = basisMatch ? String(params[Number(basisMatch[1]) - 1]) : null;

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
          config_identity_hash: params[5] ?? LEGACY_UNSCOPED_CONFIG_IDENTITY,
        });
        return { rows: [] };
      }

      if (normalized.includes('FROM candle_revision_events')) {
        const filterHash = normalized.includes('WHERE config_identity_hash = $1')
          ? String(params[0])
          : null;
        const rows = filterHash
          ? revisions.filter((r) => r.config_identity_hash === filterHash)
          : revisions;
        return { rows: rows as unknown as T[] };
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

      if (normalized.includes('FROM market_feed_checkpoints WHERE checkpoint_key = $1')) {
        const row = checkpoints.get(String(params[0]));
        return { rows: row ? ([row] as unknown as T[]) : [] };
      }

      throw new Error(`Unhandled SQL: ${normalized}`);
    },
  };

  return {
    executor,
    migrations,
    candles,
    revisions,
    checkpoints,
    getConstraints: () => ({
      hasLegacyNaturalConstraint,
      hasScopedNaturalConstraint,
    }),
  };
}

test('Stage 2B #1: unverified holiday hours (including Nov 26-27, 2026) remain UNKNOWN and fail closed; normal sessions and explicitly verified provider/division/instrument schedules classify accurately', () => {
  // 1. Default runtime NEVER assumes holiday hours for oanda_v20 without explicit verification
  const runtime = createMarketDataRuntime({
    MARKET_FEED_ENABLED: 'true',
    MARKET_DATA_PROVIDER: 'oanda_v20',
    OANDA_ENV: 'practice',
    OANDA_DIVISION: 'OANDA_US',
    OANDA_ACCOUNT_ID: '101-001-1234567-001',
    OANDA_API_TOKEN: 'secret-token-test',
    OANDA_INSTRUMENT: 'XAU_USD',
  });
  assert.equal(runtime.closurePolicy, null);

  // 2. Provenance validation refuses incomplete verification metadata
  assert.throws(
    () =>
      createVerifiedProviderSchedule({
        scheduleId: 'invalid-no-division',
        provenance: {
          provider: 'oanda_v20',
          division: '',
          instrument: 'XAU_USD',
          verifiedBy: 'ops',
          verifiedSource: 'bulletin',
          verifiedAtUtc: '2026-01-01T00:00:00.000Z',
        },
        effectiveFromNyDate: '2026-01-01',
        effectiveToNyDate: '2026-12-31',
        fullDayHolidaysNy: [],
      }),
    /division/i
  );

  // 3. Verified schedule WITHOUT explicit Nov 26–27, 2026 rules MUST classify BOTH dates as UNKNOWN
  const scheduleWithoutThanksgiving = createVerifiedProviderSchedule({
    scheduleId: 'oanda-us-xauusd-no-nov26-27',
    provenance: {
      provider: 'oanda_v20',
      division: 'OANDA_US',
      instrument: 'XAU_USD',
      verifiedBy: 'risk-desk',
      verifiedSource: 'OANDA US Metals Bulletin 2026-Q1',
      verifiedAtUtc: '2026-01-05T12:00:00.000Z',
    },
    effectiveFromNyDate: '2026-01-01',
    effectiveToNyDate: '2026-12-31',
    fullDayHolidaysNy: ['2026-01-01', '2026-12-25'],
    specialSessions: [],
  });

  // Normal trading sessions classify cleanly as OPEN_EXPECTED
  assert.equal(
    scheduleWithoutThanksgiving.inspectInstant(new Date('2026-06-15T14:00:00.000Z')).state, // Mon 10:00 EDT
    'OPEN_EXPECTED'
  );
  assert.equal(
    scheduleWithoutThanksgiving.inspectInstant(new Date('2026-11-24T15:00:00.000Z')).state, // Tue 10:00 EST
    'OPEN_EXPECTED'
  );
  assert.equal(
    scheduleWithoutThanksgiving.inspectInstant(new Date('2026-11-25T15:00:00.000Z')).state, // Wed 10:00 EST
    'OPEN_EXPECTED'
  );
  assert.equal(
    scheduleWithoutThanksgiving.inspectInstant(new Date('2026-11-30T15:00:00.000Z')).state, // Mon 10:00 EST
    'OPEN_EXPECTED'
  );
  // Weekend classifies as WEEKEND_CLOSED
  assert.equal(
    scheduleWithoutThanksgiving.inspectInstant(new Date('2026-11-28T15:00:00.000Z')).state, // Sat 10:00 EST
    'WEEKEND_CLOSED'
  );

  // Nov 26, 2026 (Thanksgiving) -> UNKNOWN throughout the day (must NEVER guess open or closed!)
  const nov26Morning = scheduleWithoutThanksgiving.inspectInstant(
    new Date('2026-11-26T15:00:00.000Z') // 10:00 EST
  );
  assert.equal(nov26Morning.state, 'UNKNOWN');
  assert.equal(nov26Morning.reason, 'UNVERIFIED_HOLIDAY_HOURS');

  const nov26Afternoon = scheduleWithoutThanksgiving.inspectInstant(
    new Date('2026-11-26T19:00:00.000Z') // 14:00 EST
  );
  assert.equal(nov26Afternoon.state, 'UNKNOWN');
  assert.equal(nov26Afternoon.reason, 'UNVERIFIED_HOLIDAY_HOURS');

  // Nov 27, 2026 (Day After Thanksgiving / Black Friday) -> UNKNOWN throughout regular session
  const nov27Morning = scheduleWithoutThanksgiving.inspectInstant(
    new Date('2026-11-27T15:00:00.000Z') // 10:00 EST
  );
  assert.equal(nov27Morning.state, 'UNKNOWN');
  assert.equal(nov27Morning.reason, 'UNVERIFIED_HOLIDAY_HOURS');

  const nov27Afternoon = scheduleWithoutThanksgiving.inspectInstant(
    new Date('2026-11-27T19:30:00.000Z') // 14:30 EST
  );
  assert.equal(nov27Afternoon.state, 'UNKNOWN');
  assert.equal(nov27Afternoon.reason, 'UNVERIFIED_HOLIDAY_HOURS');

  // Failing closed on unverified Nov 26–27 gaps & staleness
  const preNov26Gap = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-11-26T17:00:00.000Z',
    count: 1,
    granularity: 'H1',
    retrievedAtUtc: '2026-11-26T23:10:00.000Z',
  })[0];
  const postNov26Gap = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-11-26T22:00:00.000Z',
    count: 1,
    granularity: 'H1',
    retrievedAtUtc: '2026-11-26T23:10:00.000Z',
  })[0];

  const unverifiedGapCheck = validateCandleSeries([preNov26Gap, postNov26Gap], {
    nowUtc: new Date('2026-11-26T23:10:00.000Z'),
    verifiedSchedule: scheduleWithoutThanksgiving,
  });
  assert.equal(unverifiedGapCheck.valid, false);
  assert.equal(unverifiedGapCheck.missingBarCount, 4);

  const unverifiedStaleCheck = evaluateFeedStatusFreshness({
    currentState: 'CONNECTED',
    lastCompleteCandleCloseUtc: '2026-11-27T18:00:00.000Z',
    missingBarCount: 0,
    duplicateBarCount: 0,
    nowUtc: new Date('2026-11-27T20:00:00.000Z'), // 15:00 EST on unverified Nov 27
    staleThresholdSeconds: 1800,
    verifiedSchedule: scheduleWithoutThanksgiving,
    reasonCode: null,
    warnings: [],
  });
  assert.equal(unverifiedStaleCheck.state, 'STALE');
  assert.equal(unverifiedStaleCheck.reasonCode, 'FEED_DATA_STALE');

  // 4. Explicitly verified provider/division/instrument schedule covering Nov 26 & Nov 27, 2026
  const verifiedOandaUsNov2627 = createVerifiedProviderSchedule({
    scheduleId: 'oanda-us-xauusd-nov26-27-verified',
    provenance: {
      provider: 'oanda_v20',
      division: 'OANDA_US',
      instrument: 'XAU_USD',
      verifiedBy: 'desk-ops',
      verifiedSource: 'OANDA US Thanksgiving 2026 Bulletin',
      verifiedAtUtc: '2026-11-15T16:00:00.000Z',
    },
    effectiveFromNyDate: '2026-01-01',
    effectiveToNyDate: '2026-12-31',
    fullDayHolidaysNy: ['2026-01-01', '2026-12-25'],
    specialSessions: [
      {
        nyDate: '2026-11-26',
        earlyCloseNy: { hour: 13, minute: 0 },
        reopenNy: { hour: 17, minute: 0 },
        label: 'OANDA US Verified Thanksgiving Early Close (13:00–17:00 NY)',
      },
      {
        nyDate: '2026-11-27',
        earlyCloseNy: { hour: 13, minute: 45 },
        reopenNy: null,
        label: 'OANDA US Verified Day-After-Thanksgiving Early Close (13:45 NY)',
      },
    ],
  });

  // Scope matching strictly enforces provider + division + instrument
  assert.strictEqual(
    resolveVerifiedScheduleForScope([verifiedOandaUsNov2627], {
      provider: 'oanda_v20',
      division: 'OANDA_US',
      instrument: 'XAU_USD',
    }),
    verifiedOandaUsNov2627
  );
  assert.equal(
    resolveVerifiedScheduleForScope([verifiedOandaUsNov2627], {
      provider: 'oanda_v20',
      division: 'OANDA_UK',
      instrument: 'XAU_USD',
    }),
    null
  );
  assert.equal(
    resolveVerifiedScheduleForScope([verifiedOandaUsNov2627], {
      provider: 'oanda_v20',
      division: null,
      instrument: 'XAU_USD',
    }),
    null
  );
  assert.equal(
    resolveVerifiedScheduleForScope([verifiedOandaUsNov2627], {
      provider: 'other_provider',
      division: 'OANDA_US',
      instrument: 'XAU_USD',
    }),
    null
  );

  // Verified Nov 26–27 hours classify accurately for the matching scope
  assert.equal(
    verifiedOandaUsNov2627.inspectInstant(new Date('2026-11-26T17:30:00.000Z')).state, // 12:30 EST -> OPEN
    'OPEN_EXPECTED'
  );
  assert.equal(
    verifiedOandaUsNov2627.inspectInstant(new Date('2026-11-26T18:15:00.000Z')).state, // 13:15 EST -> CLOSED
    'HOLIDAY_CLOSED'
  );
  assert.equal(
    verifiedOandaUsNov2627.inspectInstant(new Date('2026-11-26T22:05:00.000Z')).state, // 17:05 EST -> REOPENED
    'OPEN_EXPECTED'
  );
  assert.equal(
    verifiedOandaUsNov2627.inspectInstant(new Date('2026-11-27T18:30:00.000Z')).state, // 13:30 EST -> OPEN
    'OPEN_EXPECTED'
  );
  assert.equal(
    verifiedOandaUsNov2627.inspectInstant(new Date('2026-11-27T18:45:00.000Z')).state, // 13:45 EST -> CLOSED
    'HOLIDAY_CLOSED'
  );
  // Still normal on Mon Nov 30, 2026
  assert.equal(
    verifiedOandaUsNov2627.inspectInstant(new Date('2026-11-30T15:00:00.000Z')).state,
    'OPEN_EXPECTED'
  );
});

test('Stage 2B #2: migration 003 safely migrates legacy rows and prevents cross-account & cross-environment candle contamination', async () => {
  const dbMock = createMigrationAwarePostgresMock();
  const dbUrl = 'postgresql://crt_test:secret@127.0.0.1:5432/crt_stage2b';

  // 1. Simulate pre-003 database (001 + 002 applied) with a legacy unscoped candle
  await runPostgresMigrations(dbMock.executor, STAGE_2A_MIGRATIONS.slice(0, 2));
  assert.equal(dbMock.getConstraints().hasLegacyNaturalConstraint, true);
  assert.equal(dbMock.getConstraints().hasScopedNaturalConstraint, false);

  const nowUtc = new Date('2026-06-15T10:50:00.000Z');
  const legacyBars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    basePrice: 2590,
    retrievedAtUtc: nowUtc.toISOString(),
  });
  const legacyStore = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: dbMock.executor,
    autoMigrate: false,
  });
  await legacyStore.upsertCandles(legacyBars, nowUtc.toISOString());
  assert.equal(dbMock.candles.size, 2);

  // 2. Apply migration 003 safely -> drops legacy natural key, enables scoped natural key, preserves legacy rows
  const mig3 = await runPostgresMigrations(dbMock.executor);
  assert.deepEqual(mig3.appliedVersions, ['003_candle_config_identity']);
  assert.deepEqual(mig3.skippedVersions, [
    '001_stage2a_market_data',
    '002_checkpoint_identity',
  ]);
  assert.equal(dbMock.getConstraints().hasLegacyNaturalConstraint, false);
  assert.equal(dbMock.getConstraints().hasScopedNaturalConstraint, true);
  for (const row of dbMock.candles.values()) {
    assert.equal(row.config_identity_hash, LEGACY_UNSCOPED_CONFIG_IDENTITY);
  }

  // Re-running migrations is strictly idempotent
  const migRepeat = await runPostgresMigrations(dbMock.executor);
  assert.deepEqual(migRepeat.appliedVersions, []);

  // 3. Three distinct feed configuration identities sharing the EXACT same DB & timestamps:
  //    - Account A (practice)
  //    - Account B (practice)
  //    - Account A (live)
  const identityPracticeA = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: 'practice',
    providerDivision: 'OANDA_US',
    accountId: '101-001-ACCOUNT-AAA',
    providerSymbol: 'XAU_USD',
    priceBasis: 'MID',
    policyVersion: '2026.1-ny17-mid',
  });
  const identityPracticeB = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: 'practice',
    providerDivision: 'OANDA_US',
    accountId: '101-001-ACCOUNT-BBB',
    providerSymbol: 'XAU_USD',
    priceBasis: 'MID',
    policyVersion: '2026.1-ny17-mid',
  });
  const identityLiveA = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: 'live',
    providerDivision: 'OANDA_US',
    accountId: '101-001-ACCOUNT-AAA',
    providerSymbol: 'XAU_USD',
    priceBasis: 'MID',
    policyVersion: '2026.1-ny17-mid',
  });

  assert.notEqual(
    identityPracticeA.configIdentityHash,
    identityPracticeB.configIdentityHash
  );
  assert.notEqual(
    identityPracticeA.configIdentityHash,
    identityLiveA.configIdentityHash
  );

  const barsPracticeA = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    basePrice: 2610,
    retrievedAtUtc: nowUtc.toISOString(),
  });
  const barsPracticeB = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    basePrice: 2625,
    retrievedAtUtc: nowUtc.toISOString(),
  });
  const barsLiveA = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    basePrice: 2640,
    retrievedAtUtc: nowUtc.toISOString(),
  });

  // Verify isolation on BOTH PostgresCandleStore and InMemoryCandleStore
  const stores = [
    new PostgresCandleStore({ databaseUrl: dbUrl, executor: dbMock.executor }),
    new InMemoryCandleStore(),
  ];

  for (const store of stores) {
    const resA = await store.upsertCandles(barsPracticeA, nowUtc.toISOString(), {
      configIdentityHash: identityPracticeA.configIdentityHash,
      providerEnv: identityPracticeA.providerEnv,
      accountScopeHash: identityPracticeA.accountScopeHash,
    });
    const resB = await store.upsertCandles(barsPracticeB, nowUtc.toISOString(), {
      configIdentityHash: identityPracticeB.configIdentityHash,
      providerEnv: identityPracticeB.providerEnv,
      accountScopeHash: identityPracticeB.accountScopeHash,
    });
    const resLive = await store.upsertCandles(barsLiveA, nowUtc.toISOString(), {
      configIdentityHash: identityLiveA.configIdentityHash,
      providerEnv: identityLiveA.providerEnv,
      accountScopeHash: identityLiveA.accountScopeHash,
    });

    // Zero overwrites and zero false revision events across distinct accounts/envs
    assert.equal(resA.inserted, 2);
    assert.equal(resB.inserted, 2);
    assert.equal(resLive.inserted, 2);
    assert.equal(resA.revisionsDetected.length, 0);
    assert.equal(resB.revisionsDetected.length, 0);
    assert.equal(resLive.revisionsDetected.length, 0);

    // Each identity reads ONLY its own candles (never legacy or cross-account candles)
    const readA = await store.getCompletedCandles({
      configIdentityHash: identityPracticeA.configIdentityHash,
      provider: 'oanda_v20',
      providerEnv: 'practice',
      accountScopeHash: identityPracticeA.accountScopeHash,
      providerSymbol: 'XAU_USD',
      priceBasis: 'MID',
      granularity: 'M15',
      limit: 10,
    });
    const readB = await store.getCompletedCandles({
      configIdentityHash: identityPracticeB.configIdentityHash,
      provider: 'oanda_v20',
      providerEnv: 'practice',
      accountScopeHash: identityPracticeB.accountScopeHash,
      providerSymbol: 'XAU_USD',
      priceBasis: 'MID',
      granularity: 'M15',
      limit: 10,
    });
    const readLive = await store.getCompletedCandles({
      configIdentityHash: identityLiveA.configIdentityHash,
      provider: 'oanda_v20',
      providerEnv: 'live',
      accountScopeHash: identityLiveA.accountScopeHash,
      providerSymbol: 'XAU_USD',
      priceBasis: 'MID',
      granularity: 'M15',
      limit: 10,
    });

    assert.equal(readA.length, 2);
    assert.equal(readB.length, 2);
    assert.equal(readLive.length, 2);
    assert.equal(readA[0].open, barsPracticeA[0].open);
    assert.equal(readB[0].open, barsPracticeB[0].open);
    assert.equal(readLive[0].open, barsLiveA[0].open);
    assert.notEqual(readA[0].open, readB[0].open);
    assert.notEqual(readA[0].open, readLive[0].open);
  }

  // 4. End-to-end worker-to-API check: Account A API runtime NEVER sees Account B candles or legacy candles
  const pgStore = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: dbMock.executor,
  });
  await pgStore.saveFeedCheckpoint({
    checkpointKey: 'XAUUSD:primary',
    configIdentityHash: identityPracticeA.configIdentityHash,
    provider: 'oanda_v20',
    providerEnv: 'practice',
    accountScopeHash: identityPracticeA.accountScopeHash,
    priceBasis: 'MID',
    policyVersion: '2026.1-ny17-mid',
    adapterName: 'OandaV20MarketDataAdapter',
    providerSymbol: 'XAU_USD',
    state: 'CONNECTED',
    providerVerified: true,
    lastSuccessfulRequestUtc: nowUtc.toISOString(),
    lastProviderCandleOpenUtc: barsPracticeA[1].openTimeUtc,
    lastCompleteCandleCloseUtc: barsPracticeA[1].closeTimeUtc,
    missingBarCount: 0,
    duplicateBarCount: 0,
    reasonCode: null,
    warnings: [],
    updatedAtUtc: nowUtc.toISOString(),
  });

  const apiRuntimeA: MarketDataRuntime = {
    fingerprint: 'acct-a-api',
    configIdentity: identityPracticeA,
    closurePolicy: null,
    adapter: new OandaV20MarketDataAdapter({
      env: 'practice',
      accountId: '101-001-ACCOUNT-AAA',
      apiToken: 'token-a',
      instrument: 'XAU_USD',
    }),
    store: pgStore,
    historyPersistence: 'POSTGRES_CONNECTED',
    backfillEnabled: false,
    marketFeedEnabled: true,
  };

  const apiCandlesA = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    nowUtc,
    apiRuntimeA
  );
  assert.equal(apiCandlesA.status, 'CONNECTED');
  assert.equal(apiCandlesA.count, 2);
  assert.equal(apiCandlesA.data[0].open, barsPracticeA[0].open);
  assert.equal(apiCandlesA.data[1].close, barsPracticeA[1].close);

  // Account B runtime querying against the same DB rejects Account A's checkpoint AND never leaks candles
  const apiRuntimeB: MarketDataRuntime = {
    fingerprint: 'acct-b-api',
    configIdentity: identityPracticeB,
    closurePolicy: null,
    adapter: new OandaV20MarketDataAdapter({
      env: 'practice',
      accountId: '101-001-ACCOUNT-BBB',
      apiToken: 'token-b',
      instrument: 'XAU_USD',
    }),
    store: pgStore,
    historyPersistence: 'POSTGRES_CONNECTED',
    backfillEnabled: false,
    marketFeedEnabled: true,
  };
  const apiCandlesB = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    nowUtc,
    apiRuntimeB
  );
  assert.equal(apiCandlesB.status, 'CONNECTING');
  assert.equal(apiCandlesB.count, 0);
  assert.deepEqual(apiCandlesB.data, []);

  // Raw account IDs never appear in persisted DB rows
  const serializedRows = JSON.stringify(Array.from(dbMock.candles.values()));
  assert.equal(serializedRows.includes('101-001-ACCOUNT-AAA'), false);
  assert.equal(serializedRows.includes('101-001-ACCOUNT-BBB'), false);
});

test('Stage 2B #3: provider-verified state without completed candles NEVER presents as CONNECTED across adapter, status, candles, or session endpoints', async () => {
  const nowUtc = new Date('2026-06-15T10:50:00.000Z');
  const bars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: nowUtc.toISOString(),
  });

  let serveCompleted = false;
  const oandaConfig: OandaV20Config = {
    env: 'practice',
    accountId: '101-001-VERIFY-ONLY',
    apiToken: 'token-verify-only',
    instrument: 'XAU_USD',
    maxRetries: 0,
  };
  const adapter = new OandaV20MarketDataAdapter(oandaConfig, {
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
      if (!serveCompleted) {
        const incompletePayload = buildSyntheticOandaRawPayload([bars[0]], 'M15');
        incompletePayload.candles[0].complete = false;
        return new Response(JSON.stringify(incompletePayload), { status: 200 });
      }
      return new Response(
        JSON.stringify(buildSyntheticOandaRawPayload(bars, 'M15')),
        { status: 200 }
      );
    },
  });

  // Step 1: Instrument verification succeeds, but 0 completed candles exist
  const verif = await adapter.verifyInstrument();
  assert.equal(verif.verified, true);
  assert.equal(verif.state, 'CONNECTING');
  assert.equal(verif.reasonCode, 'AWAITING_COMPLETED_CANDLES');

  const adapterStatus = await adapter.getStatus(nowUtc);
  assert.equal(adapterStatus.providerVerified, true);
  assert.equal(adapterStatus.quality.state, 'CONNECTING');
  assert.equal(adapterStatus.quality.reasonCode, 'AWAITING_COMPLETED_CANDLES');
  assert.equal(adapterStatus.quality.lastCompleteCandleCloseUtc, null);

  const identity = buildFeedConfigIdentity({
    provider: 'oanda_v20',
    providerEnv: 'practice',
    accountId: oandaConfig.accountId,
    providerSymbol: 'XAU_USD',
    priceBasis: adapter.alignmentPolicy.priceBasis,
    policyVersion: adapter.alignmentPolicy.policyVersion,
  });
  const store = new InMemoryCandleStore();
  const runtime: MarketDataRuntime = {
    fingerprint: 'verified-no-candles',
    configIdentity: identity,
    closurePolicy: null,
    adapter,
    store,
    historyPersistence: 'NOT_PERSISTENT',
    backfillEnabled: false,
    marketFeedEnabled: true,
  };

  // All three API routes refuse to claim CONNECTED
  const statusBefore = await buildMarketStatusPayload(nowUtc, runtime);
  assert.equal(statusBefore.providerVerified, true);
  assert.equal(statusBefore.quality.state, 'CONNECTING');
  assert.equal(statusBefore.quality.reasonCode, 'AWAITING_COMPLETED_CANDLES');

  const candlesBefore = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    nowUtc,
    runtime
  );
  assert.equal(candlesBefore.status, 'CONNECTING');
  assert.equal(candlesBefore.reasonCode, 'AWAITING_COMPLETED_CANDLES');
  assert.equal(candlesBefore.count, 0);
  assert.deepEqual(candlesBefore.data, []);

  const sessionBefore = await buildMarketSessionPayload(nowUtc, runtime);
  assert.equal(
    sessionBefore.session.observedMarketAvailability,
    'UNOBSERVED_NO_FEED'
  );

  // Step 2: Provider returns only incomplete candles -> STILL CONNECTING (never CONNECTED!)
  const incompleteFetch = await adapter.fetchCompletedCandles({
    granularity: 'M15',
    limit: 5,
  });
  assert.equal(incompleteFetch.status, 'CONNECTING');
  assert.equal(incompleteFetch.reasonCode, 'AWAITING_COMPLETED_CANDLES');
  assert.deepEqual(incompleteFetch.candles, []);

  // Step 3: Even a tampered/legacy checkpoint claiming CONNECTED with null lastCompleteCandleCloseUtc fails closed!
  await store.saveFeedCheckpoint({
    checkpointKey: 'XAUUSD:primary',
    configIdentityHash: identity.configIdentityHash,
    provider: 'oanda_v20',
    providerEnv: 'practice',
    accountScopeHash: identity.accountScopeHash,
    priceBasis: 'MID',
    policyVersion: identity.policyVersion,
    adapterName: 'OandaV20MarketDataAdapter',
    providerSymbol: 'XAU_USD',
    state: 'CONNECTED',
    providerVerified: true,
    lastSuccessfulRequestUtc: '2026-06-15T10:50:01.000Z',
    lastProviderCandleOpenUtc: null,
    lastCompleteCandleCloseUtc: null,
    missingBarCount: 0,
    duplicateBarCount: 0,
    reasonCode: null,
    warnings: [],
    updatedAtUtc: '2026-06-15T10:50:01.000Z',
  });
  const tamperedStatus = await buildMarketStatusPayload(nowUtc, runtime);
  assert.equal(tamperedStatus.quality.state, 'CONNECTING');
  assert.equal(tamperedStatus.quality.reasonCode, 'AWAITING_COMPLETED_CANDLES');

  // Step 4: Once completed candles are ingested via worker, state cleanly transitions to CONNECTED
  serveCompleted = true;
  const worker = new MarketDataIngestionWorker({
    adapter,
    store,
    configIdentity: identity,
    nowFn: () => nowUtc,
    config: {
      marketFeedEnabled: true,
      backfillEnabled: true,
      granularities: ['M15'],
    },
  });
  const cycle = await worker.runCycleOnce();
  assert.equal(cycle.status, 'COMPLETED');
  assert.equal(cycle.totalInserted, 2);

  const statusAfter = await buildMarketStatusPayload(nowUtc, runtime);
  assert.equal(statusAfter.providerVerified, true);
  assert.equal(statusAfter.quality.state, 'CONNECTED');
  assert.equal(statusAfter.quality.lastCompleteCandleCloseUtc, bars[1].closeTimeUtc);

  const candlesAfter = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    nowUtc,
    runtime
  );
  assert.equal(candlesAfter.status, 'CONNECTED');
  assert.equal(candlesAfter.count, 2);
});

test('Stage 2B #4: read-only OANDA PRACTICE smoke test verifies entitlement + M15/H1/H4/D1 completed candles, rejects live env, redacts secrets, and keeps ingestion/signals/execution disabled', async () => {
  const nowUtc = new Date('2026-06-15T10:50:00.000Z');
  const secretToken = 'practice-smoke-super-secret-token-98765';
  const accountId = '101-001-9988776-001';

  // 1. Live environment is strictly rejected with zero HTTP calls
  let liveCalls = 0;
  const liveReject = await runOandaPracticeSmokeTest({
    env: {
      OANDA_ENV: 'live',
      OANDA_ACCOUNT_ID: accountId,
      OANDA_API_TOKEN: secretToken,
      OANDA_INSTRUMENT: 'XAU_USD',
    },
    deps: {
      nowFn: () => nowUtc,
      fetchFn: async () => {
        liveCalls += 1;
        throw new Error('Must never call live endpoint');
      },
    },
  });
  assert.equal(liveReject.status, 'REJECTED');
  assert.equal(liveReject.reasonCode, 'PRACTICE_ENV_REQUIRED');
  assert.equal(liveCalls, 0);

  // 2. Missing credentials skip cleanly with zero HTTP calls
  const skipped = await runOandaPracticeSmokeTest({
    env: {},
    deps: { nowFn: () => nowUtc },
  });
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.reasonCode, 'MISSING_PRACTICE_CREDENTIALS');
  assert.equal(skipped.guarantees.continuousIngestionActivated, false);
  assert.equal(skipped.guarantees.crtEngineEnabled, false);
  assert.equal(skipped.guarantees.signalsEnabled, false);
  assert.equal(skipped.guarantees.orderExecutionEnabled, false);

  // 3. Non-XAU_USD instrument rejected
  const wrongInstrument = await runOandaPracticeSmokeTest({
    env: {
      OANDA_ENV: 'practice',
      OANDA_ACCOUNT_ID: accountId,
      OANDA_API_TOKEN: secretToken,
      OANDA_INSTRUMENT: 'EUR_USD',
    },
    deps: { nowFn: () => nowUtc },
  });
  assert.equal(wrongInstrument.status, 'REJECTED');
  assert.equal(wrongInstrument.reasonCode, 'UNSUPPORTED_INSTRUMENT_SCOPE');

  // 4. Full practice smoke pass across M15, H1, H4, and D1 (Daily)
  const observedRequests: Array<{ url: string; method: string }> = [];
  const candlesByOandaGran: Record<string, ReturnType<typeof buildSyntheticOandaRawPayload>> = {
    M15: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
        count: 3,
        granularity: 'M15',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: nowUtc.toISOString(),
      }),
      'M15'
    ),
    H1: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-15T07:00:00.000Z',
        count: 3,
        granularity: 'H1',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: nowUtc.toISOString(),
      }),
      'H1'
    ),
    H4: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-15T01:00:00.000Z',
        count: 2,
        granularity: 'H4',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: nowUtc.toISOString(),
      }),
      'H4'
    ),
    D: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-11T21:00:00.000Z',
        count: 2,
        granularity: 'D1',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: nowUtc.toISOString(),
      }),
      'D1'
    ),
  };

  const report = await runOandaPracticeSmokeTest({
    env: {
      OANDA_ENV: 'practice',
      OANDA_ACCOUNT_ID: accountId,
      OANDA_API_TOKEN: secretToken,
      OANDA_INSTRUMENT: 'XAU_USD',
    },
    sampleLimit: 3,
    deps: {
      nowFn: () => nowUtc,
      fetchFn: async (input, init) => {
        const url = String(input);
        observedRequests.push({ url, method: init?.method ?? 'GET' });
        assert.ok(
          url.startsWith('https://api-fxpractice.oanda.com/'),
          `Smoke test must ONLY hit practice host, got ${url}`
        );
        assert.equal(init?.method ?? 'GET', 'GET');

        if (url.includes('/instruments?')) {
          return new Response(
            JSON.stringify({
              instruments: [
                {
                  name: 'XAU_USD',
                  displayPrecision: 3,
                  pipLocation: -2,
                  minimumTradeSize: '1',
                },
              ],
            }),
            { status: 200 }
          );
        }
        const parsedUrl = new URL(url);
        const gran = parsedUrl.searchParams.get('granularity') ?? '';
        const payload = candlesByOandaGran[gran];
        assert.ok(payload, `Unexpected granularity requested: ${gran}`);
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    },
  });

  assert.equal(report.status, 'PASSED');
  assert.equal(report.entitlementVerified, true);
  assert.equal(report.instrumentMetadata?.providerSymbol, 'XAU_USD');
  assert.equal(report.allowedHost, 'https://api-fxpractice.oanda.com');
  assert.deepEqual(
    report.timeframes.map((t) => t.granularity),
    [...OANDA_PRACTICE_SMOKE_GRANULARITIES]
  );
  for (const tf of report.timeframes) {
    assert.equal(tf.ok, true, `${tf.granularity} should pass smoke check`);
    assert.ok(tf.completedCandleCount >= 2);
    assert.ok(tf.latestCloseTimeUtc);
  }
  assert.equal(report.guarantees.readOnly, true);
  assert.equal(report.guarantees.practiceOnly, true);
  assert.equal(report.guarantees.continuousIngestionActivated, false);
  assert.equal(report.guarantees.backfillActivated, false);
  assert.equal(report.guarantees.crtEngineEnabled, false);
  assert.equal(report.guarantees.signalsEnabled, false);
  assert.equal(report.guarantees.orderExecutionEnabled, false);

  // Confirm secrets never appear in serialized report
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secretToken), false);
  assert.equal(serialized.includes(accountId), false);

  // 5. CLI script exits 0 cleanly without credentials
  const { stdout } = await execFileAsync(
    'npx',
    ['--yes', 'tsx', 'scripts/oanda-practice-smoke.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OANDA_ENV: '',
        OANDA_ACCOUNT_ID: '',
        OANDA_API_TOKEN: '',
      },
    }
  );
  const cliReport = JSON.parse(stdout.trim());
  assert.equal(cliReport.status, 'SKIPPED');
  assert.equal(cliReport.reasonCode, 'MISSING_PRACTICE_CREDENTIALS');
});

// Live PostgreSQL migration 003 & cross-account contamination test (executes automatically in CI)
const liveTestDbUrl = process.env.TEST_DATABASE_URL?.trim();
test(
  'Stage 2B live PostgreSQL migration 003 and cross-account/cross-env candle isolation (runs when TEST_DATABASE_URL is set)',
  { skip: !liveTestDbUrl },
  async () => {
    const executor = createManagedPgExecutor(liveTestDbUrl!);
    const nowUtc = new Date('2026-06-15T10:50:00.000Z');

    try {
      await runPostgresMigrations(executor);
      const store = new PostgresCandleStore({ databaseUrl: liveTestDbUrl });
      try {
        assert.equal(await store.ensureReady(), 'POSTGRES_CONNECTED');

        const idA = buildFeedConfigIdentity({
          provider: 'oanda_v20',
          providerEnv: 'practice',
          providerDivision: 'OANDA_US',
          accountId: '101-001-CI-ACCT-A',
          providerSymbol: 'XAU_USD',
          priceBasis: 'MID',
          policyVersion: '2026.1-ny17-mid',
        });
        const idB = buildFeedConfigIdentity({
          provider: 'oanda_v20',
          providerEnv: 'practice',
          providerDivision: 'OANDA_US',
          accountId: '101-001-CI-ACCT-B',
          providerSymbol: 'XAU_USD',
          priceBasis: 'MID',
          policyVersion: '2026.1-ny17-mid',
        });

        const barsA = buildSyntheticClosedCandles({
          startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
          count: 2,
          granularity: 'M15',
          provider: 'oanda_v20',
          providerSymbol: 'XAU_USD',
          basePrice: 2700,
          retrievedAtUtc: nowUtc.toISOString(),
        });
        const barsB = buildSyntheticClosedCandles({
          startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
          count: 2,
          granularity: 'M15',
          provider: 'oanda_v20',
          providerSymbol: 'XAU_USD',
          basePrice: 2750,
          retrievedAtUtc: nowUtc.toISOString(),
        });

        // Both accounts write the exact same timestamp into the real PostgreSQL table without collision
        await store.upsertCandles(barsA, nowUtc.toISOString(), {
          configIdentityHash: idA.configIdentityHash,
          providerEnv: idA.providerEnv,
          accountScopeHash: idA.accountScopeHash,
        });
        await store.upsertCandles(barsB, nowUtc.toISOString(), {
          configIdentityHash: idB.configIdentityHash,
          providerEnv: idB.providerEnv,
          accountScopeHash: idB.accountScopeHash,
        });

        await store.saveFeedCheckpoint({
          checkpointKey: buildScopedCheckpointKey(idA.configIdentityHash),
          configIdentityHash: idA.configIdentityHash,
          provider: idA.provider,
          providerEnv: idA.providerEnv,
          accountScopeHash: idA.accountScopeHash,
          priceBasis: idA.priceBasis,
          policyVersion: idA.policyVersion,
          adapterName: 'OandaV20MarketDataAdapter',
          providerSymbol: 'XAU_USD',
          state: 'CONNECTED',
          providerVerified: true,
          lastSuccessfulRequestUtc: nowUtc.toISOString(),
          lastProviderCandleOpenUtc: barsA[1].openTimeUtc,
          lastCompleteCandleCloseUtc: barsA[1].closeTimeUtc,
          missingBarCount: 0,
          duplicateBarCount: 0,
          reasonCode: null,
          warnings: [],
          updatedAtUtc: nowUtc.toISOString(),
        });

        const readA = await store.getCompletedCandles({
          configIdentityHash: idA.configIdentityHash,
          provider: 'oanda_v20',
          providerEnv: 'practice',
          accountScopeHash: idA.accountScopeHash,
          providerSymbol: 'XAU_USD',
          priceBasis: 'MID',
          granularity: 'M15',
          limit: 10,
        });
        const readB = await store.getCompletedCandles({
          configIdentityHash: idB.configIdentityHash,
          provider: 'oanda_v20',
          providerEnv: 'practice',
          accountScopeHash: idB.accountScopeHash,
          providerSymbol: 'XAU_USD',
          priceBasis: 'MID',
          granularity: 'M15',
          limit: 10,
        });

        assert.equal(readA.length, 2);
        assert.equal(readB.length, 2);
        assert.equal(readA[0].open, barsA[0].open);
        assert.equal(readB[0].open, barsB[0].open);
      } finally {
        await store.close();
      }
    } finally {
      await executor.close();
    }
  }
);
