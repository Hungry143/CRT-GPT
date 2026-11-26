/**
 * Time-zone-aware, DST-safe clock and timestamp formatting utilities.
 * All event timestamps are kept in UTC ISO-8601; display formatting uses IANA zones
 * (`America/New_York` for market reference, `Asia/Kolkata` for user clock) via Intl.DateTimeFormat.
 * Never assumes a fixed -5 or -4 offset.
 */

export const MARKET_REFERENCE_TIMEZONE = 'America/New_York' as const;
export const USER_CLOCK_TIMEZONE = 'Asia/Kolkata' as const;

export interface FormattedZoneClock {
  timeZone: string;
  dateLabel: string;
  timeLabel: string;
  offsetLabel: string;
  fullLabel: string;
}

function parseDateInput(input: Date | string): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid UTC date input: ${String(input)}`);
  }
  return date;
}

/**
 * Returns a strict UTC ISO-8601 string (e.g. 2026-01-15T14:30:00.000Z).
 */
export function toUtcIsoString(input: Date | string = new Date()): string {
  return parseDateInput(input).toISOString();
}

/**
 * Extracts a DST-aware UTC offset label (e.g. "UTC-05:00" in winter, "UTC-04:00" in summer, "UTC+05:30" for IST)
 * using Intl.DateTimeFormat timeZoneName: 'longOffset'.
 */
export function getTimeZoneOffsetLabel(
  input: Date | string,
  timeZone: string
): string {
  const date = parseDateInput(input);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  }).formatToParts(date);

  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  if (tzPart === 'GMT' || tzPart === 'UTC') {
    return 'UTC+00:00';
  }
  return tzPart.replace('GMT', 'UTC');
}

/**
 * Extracts the short IANA zone abbreviation (e.g. "EST", "EDT", "IST" or "GMT+5:30").
 */
export function getTimeZoneShortName(
  input: Date | string,
  timeZone: string
): string {
  const date = parseDateInput(input);
  if (timeZone === USER_CLOCK_TIMEZONE) {
    return 'IST';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
    hour: '2-digit',
  }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * Formats a UTC instant in the specified IANA time zone with DST-safe offset metadata.
 */
export function formatInTimeZone(
  input: Date | string,
  timeZone: string
): FormattedZoneClock {
  const date = parseDateInput(input);

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);

  const timeLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);

  const offsetLabel = getTimeZoneOffsetLabel(date, timeZone);
  const shortName = getTimeZoneShortName(date, timeZone);

  return {
    timeZone,
    dateLabel,
    timeLabel,
    offsetLabel,
    fullLabel: `${dateLabel} ${timeLabel} ${shortName} (${offsetLabel})`,
  };
}

export function formatNewYorkClock(input: Date | string): FormattedZoneClock {
  return formatInTimeZone(input, MARKET_REFERENCE_TIMEZONE);
}

export function formatKolkataClock(input: Date | string): FormattedZoneClock {
  return formatInTimeZone(input, USER_CLOCK_TIMEZONE);
}
