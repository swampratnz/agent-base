import { config } from '../config.js';

/**
 * Minute-granularity rendering for event start/end times shown to members and
 * admins (issue #577). `Intl` handles daylight-saving transitions, so this
 * never hand-rolls a UTC offset.
 *
 * community-agent pinned `Pacific/Auckland` and the `en-NZ` locale directly
 * in this file (as `nzTime.ts`), which is a deployment fact, not a framework
 * one. Both are configuration now — `DISPLAY_TIMEZONE`/`DISPLAY_LOCALE`,
 * defaulting to `UTC`/`en-GB` — and the NZ deployment sets them in its env to
 * get byte-identical output.
 *
 * The formatter is memoised per (locale, timeZone) pair rather than built at
 * module scope: `Intl.DateTimeFormat` construction is expensive enough to be
 * worth caching, and building it lazily keeps that cost off the import path.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale} ${timeZone}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    formatters.set(key, cached);
  }
  return cached;
}

/**
 * Format an instant for display. `locale`/`timeZone` default to the
 * deployment settings; they are injectable so a test can pin an expectation
 * without depending on the ambient env.
 */
export function formatEventTime(
  instant: string | Date,
  locale: string = config.behaviour.displayLocale,
  timeZone: string = config.behaviour.displayTimezone,
): string {
  return formatter(locale, timeZone).format(typeof instant === 'string' ? new Date(instant) : instant);
}
