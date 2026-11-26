import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as getMarketSession } from '../app/api/market/session/route';
import { MarketSessionResponseSchema } from '../shared/contracts/marketData';
import {
  buildSessionClockSnapshot,
  computeCandleCloseTimeUtc,
  listTradingDayH4Opens,
} from '../shared/utils/sessionClock';

test('DST spring-forward (March 2026) keeps H4 NY local anchors at 17/21/01/05/09/13 while UTC shifts and transition bar is 3h', () => {
  // Saturday 2026-03-07 17:00 EST -> Sunday 2026-03-08 crosses spring-forward at 02:00 EST -> 03:00 EDT
  const h4Opens = listTradingDayH4Opens(2026, 3, 7);
  assert.deepEqual(
    h4Opens.map((h) => h.nyLocalHour),
    ['17:00', '21:00', '01:00', '05:00', '09:00', '13:00']
  );

  // Before DST start: 17:00 EST = 22:00Z, 01:00 EST = 06:00Z
  assert.equal(h4Opens[0].nyOffset, 'UTC-05:00');
  assert.equal(h4Opens[0].openTimeUtc, '2026-03-07T22:00:00.000Z');
  assert.equal(h4Opens[2].openTimeUtc, '2026-03-08T06:00:00.000Z');

  // After DST start: 05:00 EDT = 09:00Z (only 3 hours after 06:00Z!), 09:00 EDT = 13:00Z
  assert.equal(h4Opens[3].nyOffset, 'UTC-04:00');
  assert.equal(h4Opens[3].openTimeUtc, '2026-03-08T09:00:00.000Z');
  assert.equal(h4Opens[4].openTimeUtc, '2026-03-08T13:00:00.000Z');

  // H4 bar opened at 01:00 EST closes at 05:00 EDT (3h elapsed)
  const h4Close = computeCandleCloseTimeUtc('2026-03-08T06:00:00.000Z', 'H4');
  assert.equal(h4Close, '2026-03-08T09:00:00.000Z');
  assert.equal(
    (Date.parse(h4Close) - Date.parse('2026-03-08T06:00:00.000Z')) / 3_600_000,
    3
  );

  // D1 bar spanning spring-forward is 23h elapsed (22:00Z -> 21:00Z)
  const d1Close = computeCandleCloseTimeUtc('2026-03-07T22:00:00.000Z', 'D1');
  assert.equal(d1Close, '2026-03-08T21:00:00.000Z');
  assert.equal(
    (Date.parse(d1Close) - Date.parse('2026-03-07T22:00:00.000Z')) / 3_600_000,
    23
  );
});

test('DST fall-back (November 2026) keeps H4 NY local anchors at 17/21/01/05/09/13 while UTC shifts and transition bar is 5h, with IST constant UTC+05:30', () => {
  // Saturday 2026-10-31 17:00 EDT -> Sunday 2026-11-01 crosses fall-back at 02:00 EDT -> 01:00 EST
  const h4Opens = listTradingDayH4Opens(2026, 10, 31);
  assert.deepEqual(
    h4Opens.map((h) => h.nyLocalHour),
    ['17:00', '21:00', '01:00', '05:00', '09:00', '13:00']
  );

  // Before fall-back: 17:00 EDT = 21:00Z, 21:00 EDT = 01:00Z, 01:00 EDT = 05:00Z
  assert.equal(h4Opens[0].nyOffset, 'UTC-04:00');
  assert.equal(h4Opens[0].openTimeUtc, '2026-10-31T21:00:00.000Z');
  assert.equal(h4Opens[2].openTimeUtc, '2026-11-01T05:00:00.000Z');

  // After fall-back: 05:00 EST = 10:00Z (5 hours after 05:00Z!), 09:00 EST = 14:00Z
  assert.equal(h4Opens[3].nyOffset, 'UTC-05:00');
  assert.equal(h4Opens[3].openTimeUtc, '2026-11-01T10:00:00.000Z');
  assert.equal(h4Opens[4].openTimeUtc, '2026-11-01T14:00:00.000Z');

  // H4 bar opened at 01:00 EDT closes at 05:00 EST (5h elapsed)
  const h4Close = computeCandleCloseTimeUtc('2026-11-01T05:00:00.000Z', 'H4');
  assert.equal(h4Close, '2026-11-01T10:00:00.000Z');
  assert.equal(
    (Date.parse(h4Close) - Date.parse('2026-11-01T05:00:00.000Z')) / 3_600_000,
    5
  );

  // D1 bar spanning fall-back is 25h elapsed (21:00Z -> 22:00Z)
  const d1Close = computeCandleCloseTimeUtc('2026-10-31T21:00:00.000Z', 'D1');
  assert.equal(d1Close, '2026-11-01T22:00:00.000Z');
  assert.equal(
    (Date.parse(d1Close) - Date.parse('2026-10-31T21:00:00.000Z')) / 3_600_000,
    25
  );

  // IST remains constant UTC+05:30 before and after November 2026 NY DST transition
  const beforeFallBack = buildSessionClockSnapshot(
    new Date('2026-10-31T21:00:00.000Z')
  );
  const afterFallBack = buildSessionClockSnapshot(
    new Date('2026-11-01T14:00:00.000Z')
  );
  assert.equal(beforeFallBack.nyOffset, 'UTC-04:00');
  assert.equal(beforeFallBack.isDstActive, true);
  assert.equal(beforeFallBack.istOffset, 'UTC+05:30');
  assert.equal(afterFallBack.nyOffset, 'UTC-05:00');
  assert.equal(afterFallBack.isDstActive, false);
  assert.equal(afterFallBack.istOffset, 'UTC+05:30');
});

test('GET /api/market/session returns valid schema separating expected schedule vs observed feed availability', async () => {
  const res = await getMarketSession();
  assert.equal(res.status, 200);
  const body = MarketSessionResponseSchema.parse(await res.json());

  assert.equal(body.session.alignmentPolicy.dailyRollHourNy, 17);
  assert.equal(body.session.alignmentPolicy.alignmentTimezone, 'America/New_York');
  assert.equal(body.session.istOffset, 'UTC+05:30');
  assert.equal(body.session.expectedMarketScheduleState, 'UNKNOWN');
  assert.equal(body.session.observedMarketAvailability, 'UNOBSERVED_NO_FEED');
  assert.equal(body.session.nextBoundaries.length, 4);
});
