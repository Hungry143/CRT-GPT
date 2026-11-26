import type {
  AlignmentPolicy,
  ExpectedMarketScheduleState,
  MarketGranularity,
  NormalizedCandle,
  ObservedMarketAvailability,
  SessionBoundary,
  SessionClockSnapshot,
} from '@/shared/contracts/marketData';
import {
  formatKolkataClock,
  formatNewYorkClock,
  getTimeZoneOffsetLabel,
  getTimeZoneShortName,
  MARKET_REFERENCE_TIMEZONE,
  toUtcIsoString,
  USER_CLOCK_TIMEZONE,
} from '@/shared/utils/time';

export const H4_LOCAL_ANCHORS_NY = [17, 21, 1, 5, 9, 13] as const;

export const DEFAULT_ALIGNMENT_POLICY: AlignmentPolicy = {
  policyVersion: '2026.1-ny17-mid',
  dailyRollHourNy: 17,
  alignmentTimezone: MARKET_REFERENCE_TIMEZONE,
  userDisplayTimezone: USER_CLOCK_TIMEZONE,
  weeklyAlignment: 'Friday',
  priceBasis: 'MID',
  smooth: false,
  h4LocalAnchorsNy: ['17:00', '21:00', '01:00', '05:00', '09:00', '13:00'],
  publicationGraceSeconds: 5,
  midpointSemanticsNote:
    'Price 50% midpoint ((high + low) / 2) and elapsed-time 50% midpoint (openTime + duration / 2) are separate values.',
};

export interface NyWallClockParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  weekday: number; // 0=Sun..6=Sat
}

export interface VerifiedMarketSchedule {
  scheduleId: string;
  /**
   * Returns explicit schedule classification for a UTC instant.
   * Only verified schedules may classify a timestamp as WEEKEND_CLOSED or HOLIDAY_CLOSED.
   */
  classifyInstant: (utcDate: Date) => ExpectedMarketScheduleState;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const nyPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_REFERENCE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

/**
 * Extracts America/New_York wall-clock calendar and time parts for a UTC Date.
 * Never depends on the local OS or browser timezone.
 */
export function getNyWallClockParts(utcDate: Date): NyWallClockParts {
  const parts = nyPartsFormatter.formatToParts(utcDate);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '0';

  const rawHour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
  };
}

/**
 * Returns the America/New_York UTC offset in minutes for a UTC instant
 * (e.g. -300 for EST / UTC-05:00, -240 for EDT / UTC-04:00).
 */
export function getNyOffsetMinutes(utcDate: Date): number {
  const label = getTimeZoneOffsetLabel(utcDate, MARKET_REFERENCE_TIMEZONE);
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(label);
  if (!match) return -300;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function isNyDstActive(utcDate: Date): boolean {
  return getNyOffsetMinutes(utcDate) === -240;
}

/**
 * Resolves an America/New_York wall-clock date/time into its exact UTC Date.
 * Handles DST spring-forward and fall-back transitions deterministically.
 * On fall-back ambiguous hours (e.g. 01:00 occurring twice), selects the earlier (EDT) occurrence
 * by default so H4 sequences stay continuous after 21:00 EDT.
 */
export function nyWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
  preferEarlierAmbiguous = true
): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  // Test both EDT (-240) and EST (-300) offsets in chronological order (EDT first, EST second)
  const candidateOffsets = preferEarlierAmbiguous ? [-240, -300] : [-300, -240];
  for (const offsetMin of candidateOffsets) {
    const candidate = new Date(naiveUtcMs - offsetMin * 60_000);
    const actualOffset = getNyOffsetMinutes(candidate);
    if (actualOffset === offsetMin) {
      const check = getNyWallClockParts(candidate);
      if (
        check.year === year &&
        check.month === month &&
        check.day === day &&
        check.hour === hour &&
        check.minute === minute &&
        check.second === second
      ) {
        return candidate;
      }
    }
  }

  // Fallback for nonexistent spring-forward wall-clock minute (e.g., 02:30 on DST start day)
  const initialOffset = getNyOffsetMinutes(new Date(naiveUtcMs + 300 * 60_000));
  return new Date(naiveUtcMs - initialOffset * 60_000);
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Computes the next DST-aware boundary strictly AFTER `utcDate` for the given granularity
 * under the 17:00 America/New_York daily roll policy.
 */
export function computeNextBoundaryUtc(
  utcDate: Date,
  granularity: MarketGranularity,
  policy: AlignmentPolicy = DEFAULT_ALIGNMENT_POLICY
): Date {
  const ms = utcDate.getTime();

  if (granularity === 'M1') {
    return new Date((Math.floor(ms / 60_000) + 1) * 60_000);
  }
  if (granularity === 'M15') {
    return new Date((Math.floor(ms / 900_000) + 1) * 900_000);
  }
  if (granularity === 'H1') {
    return new Date((Math.floor(ms / 3_600_000) + 1) * 3_600_000);
  }

  const ny = getNyWallClockParts(utcDate);

  if (granularity === 'D1') {
    const sameDayRoll = nyWallClockToUtc(
      ny.year,
      ny.month,
      ny.day,
      policy.dailyRollHourNy,
      0,
      0
    );
    if (sameDayRoll.getTime() > ms) {
      return sameDayRoll;
    }
    const nextDay = addCalendarDays(ny.year, ny.month, ny.day, 1);
    return nyWallClockToUtc(
      nextDay.year,
      nextDay.month,
      nextDay.day,
      policy.dailyRollHourNy,
      0,
      0
    );
  }

  // H4 anchored to 17:00 NY -> local hours: 01:00, 05:00, 09:00, 13:00, 17:00, 21:00
  const sortedAnchors = [1, 5, 9, 13, 17, 21];
  const candidates: Date[] = [];

  for (const dayDelta of [-1, 0, 1]) {
    const d = addCalendarDays(ny.year, ny.month, ny.day, dayDelta);
    for (const anchorHour of sortedAnchors) {
      candidates.push(nyWallClockToUtc(d.year, d.month, d.day, anchorHour, 0, 0));
    }
  }

  candidates.sort((a, b) => a.getTime() - b.getTime());
  const next = candidates.find((c) => c.getTime() > ms);
  if (!next) {
    throw new Error(`Failed to resolve next H4 boundary for ${utcDate.toISOString()}`);
  }
  return next;
}

/**
 * Computes the canonical bar close UTC timestamp for a candle opened at `openTimeUtc`.
 */
export function computeCandleCloseTimeUtc(
  openTimeUtc: string | Date,
  granularity: MarketGranularity,
  policy: AlignmentPolicy = DEFAULT_ALIGNMENT_POLICY
): string {
  const openDate =
    openTimeUtc instanceof Date ? openTimeUtc : new Date(openTimeUtc);
  if (Number.isNaN(openDate.getTime())) {
    throw new RangeError(`Invalid openTimeUtc: ${String(openTimeUtc)}`);
  }
  return computeNextBoundaryUtc(openDate, granularity, policy).toISOString();
}

/**
 * Lists the 6 H4 local NY open timestamps (UTC ISO + NY HH:mm) for a trading day
 * starting at 17:00 America/New_York on the given NY calendar date.
 */
export function listTradingDayH4Opens(
  startYear: number,
  startMonth: number,
  startDay: number
): Array<{ openTimeUtc: string; nyLocalHour: string; nyOffset: string }> {
  const nextDay = addCalendarDays(startYear, startMonth, startDay, 1);
  const schedule: Array<{ y: number; m: number; d: number; h: number }> = [
    { y: startYear, m: startMonth, d: startDay, h: 17 },
    { y: startYear, m: startMonth, d: startDay, h: 21 },
    { y: nextDay.year, m: nextDay.month, d: nextDay.day, h: 1 },
    { y: nextDay.year, m: nextDay.month, d: nextDay.day, h: 5 },
    { y: nextDay.year, m: nextDay.month, d: nextDay.day, h: 9 },
    { y: nextDay.year, m: nextDay.month, d: nextDay.day, h: 13 },
  ];

  return schedule.map(({ y, m, d, h }) => {
    const utc = nyWallClockToUtc(y, m, d, h, 0, 0, true);
    const ny = getNyWallClockParts(utc);
    return {
      openTimeUtc: utc.toISOString(),
      nyLocalHour: `${String(ny.hour).padStart(2, '0')}:00`,
      nyOffset: getTimeZoneOffsetLabel(utc, MARKET_REFERENCE_TIMEZONE),
    };
  });
}

/**
 * Creates a verified FX/Metals schedule for Friday 17:00 NY -> Sunday 17:00 NY weekend closure
 * plus explicit verified holiday NY dates (YYYY-MM-DD).
 * Must only be supplied when backed by a verified schedule source.
 */
export function createVerifiedFxMetalSchedule(
  verifiedHolidayNyDates: readonly string[] = [],
  scheduleId = 'verified-fx-metals-ny17'
): VerifiedMarketSchedule {
  const holidaySet = new Set(verifiedHolidayNyDates);

  return {
    scheduleId,
    classifyInstant(utcDate: Date): ExpectedMarketScheduleState {
      const ny = getNyWallClockParts(utcDate);
      const ymd = `${ny.year}-${String(ny.month).padStart(2, '0')}-${String(ny.day).padStart(2, '0')}`;

      if (holidaySet.has(ymd)) {
        return 'HOLIDAY_CLOSED';
      }

      // Standard spot gold / FX weekend closure: Fri 17:00 NY through Sun 17:00 NY
      if (ny.weekday === 6) {
        return 'WEEKEND_CLOSED';
      }
      if (ny.weekday === 5 && ny.hour >= 17) {
        return 'WEEKEND_CLOSED';
      }
      if (ny.weekday === 0 && ny.hour < 17) {
        return 'WEEKEND_CLOSED';
      }

      return 'OPEN_EXPECTED';
    },
  };
}

/**
 * Explicitly separates a candle's price 50% midpoint from its elapsed-time 50% midpoint.
 */
export function computeCandleMidpoints(
  candle: Pick<NormalizedCandle, 'high' | 'low' | 'openTimeUtc' | 'closeTimeUtc'>,
  pricePrecision = 3
): {
  priceMidpoint: string;
  elapsedTimeMidpointUtc: string;
} {
  const highNum = Number(candle.high);
  const lowNum = Number(candle.low);
  const openMs = Date.parse(candle.openTimeUtc);
  const closeMs = Date.parse(candle.closeTimeUtc);

  if (
    !Number.isFinite(highNum) ||
    !Number.isFinite(lowNum) ||
    Number.isNaN(openMs) ||
    Number.isNaN(closeMs)
  ) {
    throw new RangeError('Invalid candle inputs for midpoint computation');
  }

  const priceMidpoint = ((highNum + lowNum) / 2).toFixed(pricePrecision);
  const elapsedTimeMidpointUtc = new Date(
    Math.floor((openMs + closeMs) / 2)
  ).toISOString();

  return {
    priceMidpoint,
    elapsedTimeMidpointUtc,
  };
}

export interface SessionClockOptions {
  policy?: AlignmentPolicy;
  verifiedSchedule?: VerifiedMarketSchedule | null;
  observedMarketAvailability?: ObservedMarketAvailability;
}

/**
 * Builds a complete DST-safe SessionClockSnapshot from canonical UTC time.
 */
export function buildSessionClockSnapshot(
  now: Date = new Date(),
  options: SessionClockOptions = {}
): SessionClockSnapshot {
  const policy = options.policy ?? DEFAULT_ALIGNMENT_POLICY;
  const nowUtc = toUtcIsoString(now);
  const ny = formatNewYorkClock(now);
  const ist = formatKolkataClock(now);
  const nyAbbr = getTimeZoneShortName(now, MARKET_REFERENCE_TIMEZONE);
  const dstActive = isNyDstActive(now);

  const boundaryGranularities: Array<'M15' | 'H1' | 'H4' | 'D1'> = [
    'M15',
    'H1',
    'H4',
    'D1',
  ];

  const nextBoundaries: SessionBoundary[] = boundaryGranularities.map(
    (granularity) => {
      const nextDate = computeNextBoundaryUtc(now, granularity, policy);
      const nextNy = formatNewYorkClock(nextDate);
      const nextNyAbbr = getTimeZoneShortName(
        nextDate,
        MARKET_REFERENCE_TIMEZONE
      );
      const secondsRemaining = Math.max(
        0,
        Math.floor((nextDate.getTime() - now.getTime()) / 1000)
      );
      return {
        granularity,
        nextBoundaryUtc: nextDate.toISOString(),
        nextBoundaryNyLocal: `${nextNy.dateLabel} ${nextNy.timeLabel} ${nextNyAbbr}`,
        secondsRemaining,
      };
    }
  );

  const expectedMarketScheduleState: ExpectedMarketScheduleState =
    options.verifiedSchedule
      ? options.verifiedSchedule.classifyInstant(now)
      : 'UNKNOWN';

  const observedMarketAvailability: ObservedMarketAvailability =
    options.observedMarketAvailability ?? 'UNOBSERVED_NO_FEED';

  return {
    nowUtc,
    nyDate: ny.dateLabel,
    nyLocalTime: ny.timeLabel,
    nyOffset: ny.offsetLabel,
    nyAbbreviation: nyAbbr,
    isDstActive: dstActive,
    istDate: ist.dateLabel,
    istDisplayTime: ist.timeLabel,
    istOffset: ist.offsetLabel,
    alignmentPolicy: policy,
    nextBoundaries,
    expectedMarketScheduleState,
    observedMarketAvailability,
    timezoneDisclaimer:
      'Candle boundaries are anchored strictly to America/New_York (17:00 NY roll) and stored in UTC. Asia/Kolkata is display-only; browser timezone is never used for anchoring. Source documents without explicit timezone are not assumed to be NY or IST.',
  };
}
