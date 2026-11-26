import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../app/api/universe/route';
import {
  INSTRUMENT_KEYS, TRADING_UNIVERSE, UniverseResponseSchema,
} from '../shared/tradingSystem/universe';
import { CrtSignalSchema } from '../shared/tradingSystem/signal';

test('all 14 instruments are unique, validated, chart-selectable and do not claim verified backend data', async () => {
  assert.equal(INSTRUMENT_KEYS.length, 14);
  assert.equal(new Set(INSTRUMENT_KEYS).size, 14);
  assert.equal(TRADING_UNIVERSE.length, 14);
  for (const item of TRADING_UNIVERSE) {
    assert.ok(item.chartSymbol.startsWith('OANDA:'));
    assert.equal(item.backendFeedVerified, false);
    assert.deepEqual(item.configuredTimeframes, ['D1', 'H4', 'H1', 'M15']);
    assert.equal('price' in item, false);
    assert.equal('signals' in item, false);
  }
  const response = await GET();
  assert.equal(response.status, 200);
  const body = UniverseResponseSchema.parse(await response.json());
  assert.deepEqual(body.data.map(item => item.key), [...INSTRUMENT_KEYS]);
});

test('full signal schema fails closed on missing snapshot, missing rule gates and impossible RR', () => {
  const invalid = CrtSignalSchema.safeParse({
    id: 'fake', instrument: 'EURUSD', lifecycle: 'CONFIRMED',
    direction: 'LONG', entry: '1.1000', stopLoss: '1.0990',
    tp1: '1.1010', tp2: '1.1020', netRiskReward: 1,
    gates: [],
  });
  assert.equal(invalid.success, false);
});
