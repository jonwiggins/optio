/**
 * Off-peak detection utility for Anthropic's 2x usage limits promotion.
 *
 * Peak hours: 8 AM – 2 PM ET (America/New_York) on weekdays (Mon–Fri)
 * Off-peak: all other times (weekday evenings/mornings + all weekend)
 * Promo window: March 13 – March 28, 2026
 */

export interface OffPeakInfo {
  /** Currently in an off-peak window */
  isOffPeak: boolean;
  /** When the current window ends (off-peak→peak) or next off-peak starts (peak→off-peak) */
  nextTransition: Date;
  /** Whether the promotion is still active (false after March 28, 2026) */
  promoActive: boolean;
}

/** Promo start: 2026-03-13T00:00:00 ET */
const PROMO_START = new Date("2026-03-13T05:00:00Z"); // midnight ET = 5 AM UTC
/** Promo end: 2026-03-29T00:00:00 ET (end of March 28) */
const PROMO_END = new Date("2026-03-29T04:00:00Z"); // midnight ET = 4 AM UTC (DST)

/** Peak start hour in ET (8 AM) */
const PEAK_START_HOUR = 8;
/** Peak end hour in ET (2 PM) */
const PEAK_END_HOUR = 14;

/**
 * Get the current hour and day-of-week in America/New_York timezone.
 */
function getETComponents(date: Date): { hour: number; minute: number; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  let hour = 0;
  let minute = 0;
  let weekday = "";
  for (const part of parts) {
    if (part.type === "hour") hour = parseInt(part.value, 10);
    if (part.type === "minute") minute = parseInt(part.value, 10);
    if (part.type === "weekday") weekday = part.value;
  }
  // Handle midnight: Intl returns 24 for hour12:false in some locales
  if (hour === 24) hour = 0;

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { hour, minute, dayOfWeek: dayMap[weekday] ?? 0 };
}

/**
 * Check if a given date falls within peak hours.
 * Peak = 8 AM – 2 PM ET on weekdays (Mon–Fri).
 */
function isPeakTime(date: Date): boolean {
  const { hour, dayOfWeek } = getETComponents(date);
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  if (!isWeekday) return false;
  return hour >= PEAK_START_HOUR && hour < PEAK_END_HOUR;
}

/**
 * Find the next transition point from the current state.
 * If currently off-peak, returns when the next peak window starts.
 * If currently peak, returns when the current peak window ends.
 */
function findNextTransition(date: Date, currentlyOffPeak: boolean): Date {
  const { hour, minute, dayOfWeek } = getETComponents(date);

  if (!currentlyOffPeak) {
    // Currently peak (weekday, 8–14 ET) → transition is today at 2 PM ET
    return getETDate(date, PEAK_END_HOUR);
  }

  // Currently off-peak → find the next peak start (next weekday at 8 AM ET)
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  if (isWeekday && hour < PEAK_START_HOUR) {
    // Before 8 AM on a weekday → peak starts today at 8 AM
    return getETDate(date, PEAK_START_HOUR);
  }

  // After peak on a weekday, or weekend → find the next weekday
  let daysUntilNextWeekday: number;
  if (dayOfWeek === 5 && (hour >= PEAK_END_HOUR || (hour === PEAK_END_HOUR && minute > 0))) {
    // Friday after peak → Monday
    daysUntilNextWeekday = 3;
  } else if (dayOfWeek === 6) {
    // Saturday → Monday
    daysUntilNextWeekday = 2;
  } else if (dayOfWeek === 0) {
    // Sunday → Monday
    daysUntilNextWeekday = 1;
  } else {
    // Weekday after peak → next day at 8 AM
    daysUntilNextWeekday = 1;
  }

  const next = new Date(date.getTime());
  next.setDate(next.getDate() + daysUntilNextWeekday);
  return getETDate(next, PEAK_START_HOUR);
}

/**
 * Create a Date for a specific hour in ET on the same calendar day as `ref`.
 */
function getETDate(ref: Date, targetHourET: number): Date {
  // Get the current date in ET
  const etDateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ref);

  // Parse "MM/DD/YYYY" format
  const [month, day, year] = etDateStr.split("/").map(Number);

  // Build an ISO-ish string and let the timezone offset handle the rest
  // We use a two-pass approach: create a date at the target hour in ET,
  // then adjust for the actual UTC offset at that time.
  const guess = new Date(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(targetHourET).padStart(2, "0")}:00:00`,
  );

  // Get what ET thinks this is, including minutes (sub-hour timezone offsets like IST = UTC+5:30
  // would otherwise introduce a 30-minute drift when using setHours in local time).
  const { hour: guessHour, minute: guessMinute } = getETComponents(guess);
  const driftMs = (guessHour - targetHourET) * 60 * 60 * 1000 + guessMinute * 60 * 1000;
  guess.setTime(guess.getTime() - driftMs);

  return guess;
}

/**
 * Get off-peak information for a given date (defaults to now).
 */
export function getOffPeakInfo(date?: Date): OffPeakInfo {
  const now = date ?? new Date();
  const promoActive = now >= PROMO_START && now < PROMO_END;
  const isOffPeak = !isPeakTime(now);
  const nextTransition = findNextTransition(now, isOffPeak);

  return { isOffPeak, nextTransition, promoActive };
}

/**
 * Returns milliseconds until the next off-peak window starts.
 * Returns 0 if currently off-peak.
 */
export function msUntilOffPeak(date?: Date): number {
  const now = date ?? new Date();
  const info = getOffPeakInfo(now);
  if (info.isOffPeak) return 0;
  return Math.max(0, info.nextTransition.getTime() - now.getTime());
}
