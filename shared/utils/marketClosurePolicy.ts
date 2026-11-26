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

/**
 * Explicit verification metadata proving a schedule was confirmed for a specific
 * provider, regulatory division, and instrument rather than assumed globally.
 */
export interface ScheduleVerificationProvenance {
  provider: string;
  division: string;
  instrument: string;
  verifiedBy: string;
  verifiedSource: string;
  verifiedAtUtc: string;
}

export interface ScheduleScopeTarget {
  provider: string;
  division: string | null;
  instrument: string;
}

/**
 * Major spot-metals holiday / early-close ambiguity dates (America/New_York calendar dates)
 * whose exact trading hours vary materially across liquidity providers and OANDA divisions
 * (including US Thanksgiving Nov 26, 2026 and Day After Thanksgiving Nov 27, 2026).
 *
 * Any watch date NOT explicitly verified in a provider/division/instrument schedule
 * MUST classify as `UNKNOWN` and fail closed rather than guessing open or closed hours.
 */
export const UNVERIFIED_HOLIDAY_WATCH_DATES_NY: readonly string[] = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Jr. Day (early close varies by provider/division)
  '2026-02-16', // Presidents' Day (early close varies by provider/division)
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day (early close varies by provider/division)
  '2026-06-19', // Juneteenth (early close varies by provider/division)
  '2026-07-03', // US Independence Day Observed
  '2026-09-07', // Labor Day (early close varies by provider/division)
  '2026-11-26', // US Thanksgiving Day (provider/division early-close hours differ)
  '2026-11-27', // Day After Thanksgiving / Black Friday (provider/division early-close hours differ)
  '2026-12-24', // Christmas Eve
  '2026-12-25', // Christmas Day
  '2026-12-31', // New Year's Eve
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Jr. Day
  '2027-02-15', // Presidents' Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth Observed
  '2027-07-05', // US Independence Day Observed
  '2027-09-06', // Labor Day
  '2027-11-25', // US Thanksgiving Day
  '2027-11-26', // Day After Thanksgiving
  '2027-12-24', // Christmas Eve
  '2027-12-25', // Christmas Day
  '2027-12-31', // New Year's Eve
] as const;

export interface MarketClosurePolicyConfig {
  scheduleId: string;
  /**
   * Inclusive NY calendar coverage bounds (YYYY-MM-DD).
   * Any timestamp outside this verified coverage window classifies as `UNKNOWN`
   * so unverified future/past years never silently masquerade as guaranteed open.
   */
  effectiveFromNyDate: string;
  effectiveToNyDate: string;
  /** Full-day market holidays explicitly verified for this schedule (YYYY-MM-DD in NY time) */
  fullDayHolidaysNy: readonly string[];
  /** Special early-close or late-open sessions explicitly verified for this schedule in NY time */
  specialSessions?: readonly SpecialTradingSessionRule[];
  /**
   * Holiday watch dates explicitly verified to run regular (unmodified) trading hours
   * for this provider/division/instrument.
   */
  explicitlyVerifiedNormalTradingDatesNy?: readonly string[];
  /**
   * Holiday/special-hour watch dates that MUST classify as `UNKNOWN` unless explicitly
   * verified in `fullDayHolidaysNy`, `specialSessions`, or `explicitlyVerifiedNormalTradingDatesNy`.
   * Defaults to `UNVERIFIED_HOLIDAY_WATCH_DATES_NY`.
   */
  unverifiedWatchDatesNy?: readonly string[];
  /**
   * Whether standard spot FX/metals weekend closures (Fri 17:00 NY -> Sun 17:00 NY)
   * have been explicitly verified for this provider/division/instrument. Defaults to `true`.
   */
  weekendClosureVerified?: boolean;
  /** Optional daily maintenance break in NY local time (Mon–Thu), e.g. 17:00–18:00 NY */
  dailyMaintenanceWindowNy?: {
    start: NyTimeOfDay;
    end: NyTimeOfDay;
    label?: string;
  } | null;
  /** Optional explicit UTC closure intervals (e.g. verified exchange/provider halt windows) */
  explicitClosuresUtc?: readonly ExplicitUtcClosureWindow[];
  /** Optional verification provenance metadata */
  provenance?: ScheduleVerificationProvenance;
}

export interface VerifiedProviderScheduleConfig
  extends MarketClosurePolicyConfig {
  provenance: ScheduleVerificationProvenance;
}

export interface MarketClosureInspection {
  state: ExpectedMarketScheduleState;
  scheduleId: string;
  nyDate: string;
  reason: string;
  ruleLabel: string | null;
  provenance: ScheduleVerificationProvenance | null;
}

export interface AuthoritativeMarketClosurePolicy
  extends VerifiedMarketSchedule {
  readonly config: MarketClosurePolicyConfig;
  readonly provenance: ScheduleVerificationProvenance | null;
  inspectInstant(utcDate: Date): MarketClosureInspection;
}

export interface VerifiedProviderMarketSchedule
  extends AuthoritativeMarketClosurePolicy {
  readonly provenance: ScheduleVerificationProvenance;
  matchesScope(scope: ScheduleScopeTarget): boolean;
}

function toMinutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function assertValidProvenance(provenance: ScheduleVerificationProvenance): void {
  if (!provenance.provider.trim()) {
    throw new Error('Verified schedule provenance requires a non-empty provider');
  }
  if (!provenance.division.trim()) {
    throw new Error('Verified schedule provenance requires a non-empty division');
  }
  if (!provenance.instrument.trim()) {
    throw new Error(
      'Verified schedule provenance requires a non-empty instrument'
    );
  }
  if (!provenance.verifiedBy.trim()) {
    throw new Error(
      'Verified schedule provenance requires a non-empty verifiedBy attribution'
    );
  }
  if (!provenance.verifiedSource.trim()) {
    throw new Error(
      'Verified schedule provenance requires a non-empty verifiedSource reference'
    );
  }
  if (Number.isNaN(Date.parse(provenance.verifiedAtUtc))) {
    throw new Error(
      'Verified schedule provenance requires a valid ISO-8601 verifiedAtUtc timestamp'
    );
  }
}

/**
 * Creates a testable market-session closure policy covering:
 * - Verified coverage window (out-of-range dates return UNKNOWN and fail closed)
 * - Unverified holiday watch dates (including Nov 26-27, 2026) return UNKNOWN unless explicitly verified
 * - Standard spot metals / FX weekend closure (Fri 17:00 NY -> Sun 17:00 NY) when verified
 * - Explicitly verified full-day holidays and special trading hours in NY local time
 * - Optional daily maintenance breaks and explicit UTC closure windows
 */
export function createMarketClosurePolicy(
  config: MarketClosurePolicyConfig
): AuthoritativeMarketClosurePolicy {
  const holidaySet = new Set(config.fullDayHolidaysNy);
  const verifiedNormalSet = new Set(
    config.explicitlyVerifiedNormalTradingDatesNy ?? []
  );
  const watchDateSet = new Set(
    config.unverifiedWatchDatesNy ?? UNVERIFIED_HOLIDAY_WATCH_DATES_NY
  );
  const specialByDate = new Map<string, SpecialTradingSessionRule>();
  for (const rule of config.specialSessions ?? []) {
    specialByDate.set(rule.nyDate, rule);
  }
  const weekendClosureVerified = config.weekendClosureVerified ?? true;
  const provenance = config.provenance ?? null;

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

    // Outside verified calendar coverage -> UNKNOWN (fails closed on staleness/gaps)
    if (ymd < config.effectiveFromNyDate || ymd > config.effectiveToNyDate) {
      return {
        state: 'UNKNOWN',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'OUTSIDE_POLICY_COVERAGE_WINDOW',
        ruleLabel: null,
        provenance,
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
          provenance,
        };
      }
    }

    // Standard spot gold / FX weekend closure: Fri 17:00 NY -> Sun 17:00 NY
    if (
      ny.weekday === 6 ||
      (ny.weekday === 5 && ny.hour >= 17) ||
      (ny.weekday === 0 && ny.hour < 17)
    ) {
      if (!weekendClosureVerified) {
        return {
          state: 'UNKNOWN',
          scheduleId: config.scheduleId,
          nyDate: ymd,
          reason: 'UNVERIFIED_WEEKEND_HOURS',
          ruleLabel: null,
          provenance,
        };
      }
      return {
        state: 'WEEKEND_CLOSED',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'STANDARD_WEEKEND_CLOSURE',
        ruleLabel: 'Weekend closure (Fri 17:00 NY – Sun 17:00 NY)',
        provenance,
      };
    }

    // Full-day verified holiday
    if (holidaySet.has(ymd)) {
      return {
        state: 'HOLIDAY_CLOSED',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'VERIFIED_FULL_DAY_HOLIDAY',
        ruleLabel: `Verified market holiday (${ymd})`,
        provenance,
      };
    }

    // Explicitly verified special trading hours (late open / early close)
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
            provenance,
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
            provenance,
          };
        }
      }
    } else if (watchDateSet.has(ymd) && !verifiedNormalSet.has(ymd)) {
      // Unverified holiday/special-hours watch date -> MUST remain UNKNOWN and fail closed!
      return {
        state: 'UNKNOWN',
        scheduleId: config.scheduleId,
        nyDate: ymd,
        reason: 'UNVERIFIED_HOLIDAY_HOURS',
        ruleLabel: `Unverified holiday/special hours for ${ymd}; provider/division verification required`,
        provenance,
      };
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
          provenance,
        };
      }
    }

    return {
      state: 'OPEN_EXPECTED',
      scheduleId: config.scheduleId,
      nyDate: ymd,
      reason: 'REGULAR_TRADING_SESSION',
      ruleLabel: null,
      provenance,
    };
  };

  return {
    scheduleId: config.scheduleId,
    config,
    provenance,
    inspectInstant,
    classifyInstant(utcDate: Date): ExpectedMarketScheduleState {
      return inspectInstant(utcDate).state;
    },
  };
}

/**
 * Creates an explicitly verified, provider-, division-, and instrument-specific schedule.
 *
 * Guarantees:
 * - Requires explicit verification provenance (`provider`, `division`, `instrument`,
 *   `verifiedBy`, `verifiedSource`, `verifiedAtUtc`).
 * - Matches ONLY the exact `(provider, division, instrument)` scope.
 * - Any unverified holiday watch date (including Nov 26–27, 2026) remains `UNKNOWN`
 *   and fails closed unless explicitly verified for this exact provider, division, and instrument.
 */
export function createVerifiedProviderSchedule(
  config: VerifiedProviderScheduleConfig
): VerifiedProviderMarketSchedule {
  assertValidProvenance(config.provenance);
  const policy = createMarketClosurePolicy(config);

  const expectedProvider = normalizeToken(config.provenance.provider);
  const expectedDivision = normalizeToken(config.provenance.division);
  const expectedInstrument = normalizeToken(config.provenance.instrument);

  return {
    ...policy,
    provenance: config.provenance,
    matchesScope(scope: ScheduleScopeTarget): boolean {
      if (!scope.division || !scope.division.trim()) {
        return false;
      }
      return (
        normalizeToken(scope.provider) === expectedProvider &&
        normalizeToken(scope.division) === expectedDivision &&
        normalizeToken(scope.instrument) === expectedInstrument
      );
    },
  };
}

/**
 * Resolves a verified provider/division/instrument schedule ONLY when every scope field
 * (`provider`, `division`, `instrument`) matches an explicitly verified schedule entry.
 * Returns `null` when unverified so unknown hours remain `UNKNOWN` and fail closed.
 */
export function resolveVerifiedScheduleForScope(
  schedules: readonly VerifiedProviderMarketSchedule[],
  scope: ScheduleScopeTarget
): VerifiedProviderMarketSchedule | null {
  for (const schedule of schedules) {
    if (schedule.matchesScope(scope)) {
      return schedule;
    }
  }
  return null;
}

/**
 * Registered production provider/division/instrument verified schedules.
 * Intentionally empty by default: holiday and special trading hours must NEVER be assumed
 * globally and must only be registered after explicit provider/division bulletin verification.
 */
export const REGISTERED_VERIFIED_PROVIDER_SCHEDULES: readonly VerifiedProviderMarketSchedule[] =
  [];
