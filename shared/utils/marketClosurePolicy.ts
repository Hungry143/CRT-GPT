import type { ExpectedMarketScheduleState } from '@/shared/contracts/marketData';
import {
  getNyWallClockParts,
  type VerifiedMarketSchedule,
} from '@/shared/utils/sessionClock';

export interface NyTimeOfDay {
  hour: number; // 0-23
  minute: number; // 0-59
}

export interface SpecialTradingSessionRule {
  /** NY calendar date (YYYY-MM-DD) when special hours apply */
  nyDate: string;
  label: string;
  /** Market closes early at this NY local time (inclusive) */
  earlyCloseNy?: NyTimeOfDay;
  /**
   * Optional NY local reopen time on the same NY calendar date (e.g. 17:00 NY daily roll).
   * When omitted or null, earlyCloseNy remains closed through midnight into the next calendar day
   * (e.g. Christmas Eve into Christmas Day).
   */
  reopenNy?: NyTimeOfDay | null;
  /** Market opens late at this NY local time (closed strictly before this NY time on nyDate) */
  lateOpenNy?: NyTimeOfDay;
}

export interface ExplicitUtcClosureWindow {
  startUtc: string;
  endUtc: string;
  kind: 'WEEKEND_CLOSED' | 'HOLIDAY_CLOSED';
  label: string;
}

export interface MarketClosurePolicyConfig {
  scheduleId: string;
  /**
   * Inclusive NY calendar coverage bounds (YYYY-MM-DD).
   * Any timestamp outside this verified coverage window classifies as `UNKNOWN`
   * so unverified future/past years never silently masquerade as guaranteed open.
   */
  effectiveFromNyDate: string;
  effectiveToNyDate: string;
  /** Full-day market holidays in NY calendar dates (YYYY-MM-DD) */
  fullDayHolidaysNy: readonly string[];
  /** Special early-close or late-open sessions in NY time */
  specialSessions?: readonly SpecialTradingSessionRule[];
  /** Optional daily maintenance break in NY local time (Mon–Thu), e.g. 17:00–18:00 NY */
  dailyMaintenanceWindowNy?: {
    start: NyTimeOfDay;
    end: NyTimeOfDay;
    label?: string;
  } | null;
  /** Optional explicit UTC closure intervals (e.g. verified exchange/provider halt windows) */
  explicitClosuresUtc?: readonly ExplicitUtcClosureWindow[];
}

export interface MarketClosureInspection {
  state: ExpectedMarketScheduleState;
  scheduleId: string;
  nyDate: string;
  reason: string;
  ruleLabel: string | null;
}

export interface AuthoritativeMarketClosurePolicy
  extends VerifiedMarketSchedule {
  readonly config: MarketClosurePolicyConfig;
  inspectInstant(utcDate: Date): MarketClosureInspection;
}

function toMinutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Creates an authoritative, testable market-session closure policy covering:
 * - Verified coverage window (out-of-range dates return UNKNOWN and fail closed)
 * - Standard spot metals / FX weekend closure (Fri 17:00 NY -> Sun 17:00 NY)
 * - Full-day holidays (NY calendar dates)
 * - Special trading hours (early closes and late opens in NY local time)
 * - Optional daily maintenance breaks and explicit UTC closure windows
 */
export function createMarketClosurePolicy(
  config: MarketClosurePolicyConfig
): AuthoritativeMarketClosurePolicy {
  const holidaySet = new Set(config.fullDayHolidaysNy);
  const specialByDate = new Map<string, SpecialTradingSessionRule>();
  for (const rule of config.specialSessions ?? []) {
    specialByDate.set(rule.nyDate, rule);
  }

  const parsedExplicitClosures = (config.explicitClosuresUtc ?? [])
    .map((w) => ({
      startMs: Date.parse(w.startUtc),
      endMs: Date.parse(w.endUtc),
      kind: w.kind,
      label: w.label,
    }))
    .filter(
      (w) =>
        !Number.isNaN(w.startMs) &&
        !Number.isNaN(w.endMs) &&
        w.endMs > w.startMs
    );

  const inspectInstant = (utcDate: Date): MarketClosureInspection => {
    const ny = getNyWallClockParts(utcDate);
    const ymd = formatYmd(ny.year, ny.month, ny.day);
    const minuteOfDay = toMinutesOfDay(ny.hour, ny.minute);
    const instantMs = utcDate.getTime();

    // Outside authoritative calendar coverage -> UNKNOWN (fails closed on staleness/gaps)
    if (ymd < config.effectiveFromNyDate || ymd > config.effectiveToNyDate) {
      return {
        state: 'UNKNOWN',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'OUTSIDE_POLICY_COVERAGE_WINDOW',
        ruleLabel: null,
      };
    }

    // Explicit verified UTC closure intervals take highest precedence
    for (const closure of parsedExplicitClosures) {
      if (instantMs >= closure.startMs && instantMs < closure.endMs) {
        return {
          state: closure.kind,
          scheduleId: config.scheduleId,
          nyDate: ymd,
          reason: 'EXPLICIT_UTC_CLOSURE',
          ruleLabel: closure.label,
        };
      }
    }

    // Standard spot gold / FX weekend closure: Fri 17:00 NY -> Sun 17:00 NY
    if (
      ny.weekday === 6 ||
      (ny.weekday === 5 && ny.hour >= 17) ||
      (ny.weekday === 0 && ny.hour < 17)
    ) {
      return {
        state: 'WEEKEND_CLOSED',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'STANDARD_WEEKEND_CLOSURE',
        ruleLabel: 'Weekend closure (Fri 17:00 NY – Sun 17:00 NY)',
      };
    }

    // Full-day verified holiday
    if (holidaySet.has(ymd)) {
      return {
        state: 'HOLIDAY_CLOSED',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'VERIFIED_FULL_DAY_HOLIDAY',
        ruleLabel: `Market holiday (${ymd})`,
      };
    }

    // Special trading hours (late open / early close)
    const special = specialByDate.get(ymd);
    if (special) {
      if (special.lateOpenNy) {
        const lateOpenMin = toMinutesOfDay(
          special.lateOpenNy.hour,
          special.lateOpenNy.minute
        );
        if (minuteOfDay < lateOpenMin) {
          return {
            state: 'HOLIDAY_CLOSED',
            scheduleId: config.scheduleId,
            nyDate: ymd,
            reason: 'SPECIAL_SESSION_LATE_OPEN',
            ruleLabel: special.label,
          };
        }
      }
      if (special.earlyCloseNy) {
        const earlyCloseMin = toMinutesOfDay(
          special.earlyCloseNy.hour,
          special.earlyCloseNy.minute
        );
        const reopenMin = special.reopenNy
          ? toMinutesOfDay(special.reopenNy.hour, special.reopenNy.minute)
          : 24 * 60;
        if (minuteOfDay >= earlyCloseMin && minuteOfDay < reopenMin) {
          return {
            state: 'HOLIDAY_CLOSED',
            scheduleId: config.scheduleId,
            nyDate: ymd,
            reason: 'SPECIAL_SESSION_EARLY_CLOSE',
            ruleLabel: special.label,
          };
        }
      }
    }

    // Optional daily maintenance break (Mon-Thu)
    if (
      config.dailyMaintenanceWindowNy &&
      ny.weekday >= 1 &&
      ny.weekday <= 4
    ) {
      const startMin = toMinutesOfDay(
        config.dailyMaintenanceWindowNy.start.hour,
        config.dailyMaintenanceWindowNy.start.minute
      );
      const endMin = toMinutesOfDay(
        config.dailyMaintenanceWindowNy.end.hour,
        config.dailyMaintenanceWindowNy.end.minute
      );
      if (minuteOfDay >= startMin && minuteOfDay < endMin) {
        return {
          state: 'HOLIDAY_CLOSED',
          scheduleId: config.scheduleId,
          nyDate: ymd,
          reason: 'DAILY_MAINTENANCE_BREAK',
          ruleLabel:
            config.dailyMaintenanceWindowNy.label ??
            'Daily NY rollover maintenance break',
        };
      }
    }

    return {
      state: 'OPEN_EXPECTED',
      scheduleId: config.scheduleId,
      nyDate: ymd,
      reason: 'REGULAR_TRADING_SESSION',
      ruleLabel: null,
    };
  };

  return {
    scheduleId: config.scheduleId,
    config,
    inspectInstant,
    classifyInstant(utcDate: Date): ExpectedMarketScheduleState {
      return inspectInstant(utcDate).state;
    },
  };
}

/**
 * Authoritative 2026–2027 XAUUSD (spot gold) session closure policy anchored to America/New_York:
 * - Standard weekend closure: Fri 17:00 NY – Sun 17:00 NY
 * - Core global spot metals full-day closures (New Year's Day, Good Friday, Christmas Day)
 * - US holiday early-close special sessions (Independence Day observed, Thanksgiving, Christmas Eve, New Year's Eve)
 * - Dates outside 2026-01-01..2027-12-31 explicitly classify as UNKNOWN (fail closed)
 */
export function createAuthoritativeXauUsdClosurePolicy(
  overrides: Partial<MarketClosurePolicyConfig> = {}
): AuthoritativeMarketClosurePolicy {
  return createMarketClosurePolicy({
    scheduleId: 'xauusd-ny17-authoritative-2026-2027',
    effectiveFromNyDate: '2026-01-01',
    effectiveToNyDate: '2027-12-31',
    fullDayHolidaysNy: [
      '2026-01-01', // New Year's Day
      '2026-04-03', // Good Friday
      '2026-12-25', // Christmas Day
      '2027-01-01', // New Year's Day
      '2027-03-26', // Good Friday
      '2027-12-25', // Christmas Day
    ],
    specialSessions: [
      {
        nyDate: '2026-07-03',
        earlyCloseNy: { hour: 13, minute: 0 },
        reopenNy: null, // Friday early close rolls directly into Fri 17:00 NY weekend closure
        label: 'US Independence Day Observed Early Close (13:00 NY)',
      },
      {
        nyDate: '2026-11-26',
        earlyCloseNy: { hour: 13, minute: 0 },
        reopenNy: { hour: 17, minute: 0 }, // Thursday reopens at 17:00 NY daily roll
        label: 'US Thanksgiving Early Close (13:00 NY – 17:00 NY)',
      },
      {
        nyDate: '2026-12-24',
        earlyCloseNy: { hour: 13, minute: 30 },
        reopenNy: null, // Stays closed into Christmas Day full-day holiday
        label: 'Christmas Eve Early Close (13:30 NY)',
      },
      {
        nyDate: '2026-12-31',
        earlyCloseNy: { hour: 16, minute: 0 },
        reopenNy: null, // Stays closed into New Year's Day full-day holiday
        label: "New Year's Eve Early Close (16:00 NY)",
      },
    ],
    dailyMaintenanceWindowNy: null,
    explicitClosuresUtc: [],
    ...overrides,
  });
}
