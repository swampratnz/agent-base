import type { Tier } from './auth/tiers.js';
import { logger } from './logger.js';
import type { Platform } from './platforms/types.js';

/**
 * The per-person daily reply ceiling (`DAILY_REPLY_LIMIT_PER_USER`), and the
 * module's say in it.
 *
 * The base answers one person at most `dailyReplyLimitPerUser` times in a
 * rolling 24 hours. That is a sensible guard for a community bot on a chat
 * platform, where nothing else bounds what one person can make it spend. A
 * module that bounds spend another way (a weekly model budget per
 * organisation, with each person's share of it) wants the per-person count
 * only as an abuse ceiling, set far higher, and perhaps only on some
 * platforms. This seam lets it say so per message.
 *
 * The resolver is handed who is asking and nothing else. It answers a whole
 * number of replies, or `undefined` for the deployment's own figure. An
 * answer that is not a whole number from 1 to `DAILY_REPLY_LIMIT_MAX` is
 * ignored, and so is a resolver that throws: a module cannot switch the
 * ceiling off through here, only move it.
 */
export interface DailyReplyLimitRequest {
  readonly platform: Platform;
  readonly userId: string;
  /** The caller's tier, as the spine resolved it. A super admin is never counted. */
  readonly role: Tier;
}

export type DailyReplyLimitResolver = (request: DailyReplyLimitRequest) => number | undefined;

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
 * The ceiling for this caller: the module's figure when it gives a valid one,
 * else `fallback` (the deployment's `dailyReplyLimitPerUser`, where 0 means no
 * ceiling). Never throws.
 */
export function resolveDailyReplyLimit(request: DailyReplyLimitRequest, fallback: number): number {
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
  if (
    typeof answer !== 'number' ||
    !Number.isInteger(answer) ||
    answer < 1 ||
    answer > DAILY_REPLY_LIMIT_MAX
  ) {
    logger.warn(
      { platform: request.platform },
      'Daily reply limit resolver answered no usable ceiling; the deployment figure is used',
    );
    return fallback;
  }
  return answer;
}

/**
 * Whether one more reply is over the ceiling. `limit` 0 is no ceiling; a
 * super admin is never counted.
 */
export function overDailyReplyLimit(used: number, limit: number, role: Tier): boolean {
  return limit > 0 && role !== 'super_admin' && used >= limit;
}
