import type { Tier } from './auth/tiers.js';
import { logger } from './logger.js';
import type { Platform } from './platforms/types.js';

/**
 * The per-person daily reply ceiling (`DAILY_REPLY_LIMIT_PER_USER`), and the
 * module's say in it.
 *
 * The base answers one person at most `dailyReplyLimitPerUser` times in a
 * rolling 24 hours, and tells them once in that window; later messages get
 * nothing. That is a sensible guard for a community bot on a chat platform,
 * where nothing else bounds what one person can make it spend and silence is
 * how a shed message ought to look. A module that bounds spend another way (a
 * weekly model budget per organisation, with each person's share of it) wants
 * the per-person count as an abuse ceiling only, set far higher, and on the
 * web, where a person who sends a message waits for its answer, it wants
 * every message over the ceiling answered. This seam lets it say both, per
 * caller.
 *
 * The resolver is handed who is asking and nothing else. It answers a
 * ceiling, or `undefined` for the deployment's own. A limit that is not a
 * whole number from 1 to `DAILY_REPLY_LIMIT_MAX` is ignored, and so is a
 * resolver that throws: a module cannot switch the ceiling off through here,
 * only move it.
 */
export interface DailyReplyLimitRequest {
  readonly platform: Platform;
  readonly userId: string;
  /** The caller's tier, as the spine resolved it. A super admin is never counted. */
  readonly role: Tier;
}

export interface DailyReplyCeiling {
  /** Replies in a rolling 24 hours. 0 (the deployment's figure only) is no ceiling. */
  readonly limit: number;
  /** Answer every message over the ceiling with the notice, rather than once in 24 hours. */
  readonly noticeEachMessage: boolean;
}

export type DailyReplyLimitResolver = (request: DailyReplyLimitRequest) => DailyReplyCeiling | undefined;

/** The highest ceiling a module may set: past this it is no ceiling at all. */
export const DAILY_REPLY_LIMIT_MAX = 100_000;

let resolver: DailyReplyLimitResolver | null = null;

/** Once per process, from the `dailyReplyLimit` manifest field. */
export function registerDailyReplyLimitResolver(next: DailyReplyLimitResolver): void {
  if (resolver)
    throw new Error('daily reply limit resolver already registered — it cannot be swapped after boot');
  resolver = next;
}

/** Test seam only. */
export function resetDailyReplyLimitResolverForTest(): void {
  resolver = null;
}

/**
 * The ceiling for this caller: the module's when it gives a valid one, else
 * `fallbackLimit` (the deployment's `dailyReplyLimitPerUser`, where 0 means no
 * ceiling) with the once-a-day notice. Never throws.
 */
export function resolveDailyReplyLimit(
  request: DailyReplyLimitRequest,
  fallbackLimit: number,
): DailyReplyCeiling {
  const fallback: DailyReplyCeiling = { limit: fallbackLimit, noticeEachMessage: false };
  if (!resolver) return fallback;
  let answer: unknown;
  try {
    answer = resolver(request);
  } catch (err) {
    logger.warn(
      { err, platform: request.platform },
      'Daily reply limit resolver threw; the deployment figure is used',
    );
    return fallback;
  }
  if (answer === undefined) return fallback;
  const ceiling = usableCeiling(answer);
  if (!ceiling) {
    logger.warn(
      { platform: request.platform },
      'Daily reply limit resolver answered no usable ceiling; the deployment figure is used',
    );
    return fallback;
  }
  return ceiling;
}

/** A resolver's answer as a ceiling, or null when it is not one: whatever a module's code handed back. */
function usableCeiling(answer: unknown): DailyReplyCeiling | null {
  if (answer === null || typeof answer !== 'object') return null;
  const { limit, noticeEachMessage } = answer as { limit?: unknown; noticeEachMessage?: unknown };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > DAILY_REPLY_LIMIT_MAX)
    return null;
  return { limit, noticeEachMessage: noticeEachMessage === true };
}

/**
 * Whether one more reply is over the ceiling. `limit` 0 is no ceiling; a
 * super admin is never counted.
 */
export function overDailyReplyLimit(used: number, limit: number, role: Tier): boolean {
  return limit > 0 && role !== 'super_admin' && used >= limit;
}
