import type { CallerContext } from '../auth/rbac.js';
import { logger } from '../logger.js';

/**
 * What a person is told when a turn fails on a usage limit, when the module
 * knows more than "the limit has been reached" (WattoBot BASE-GAPS 27).
 *
 * A deployment that reaches the model through a gateway has limits of its
 * own: the gateway refuses a call once an organisation has spent its weekly
 * budget, and it knows the day the budget resets. The base never echoes an
 * upstream error, so the person got the fixed `usageLimitReply` and was not
 * told when. This seam lets the module say it.
 *
 * The resolver is handed the caller and nothing else. In particular it is
 * never handed the error: what it returns is a sentence the module composed
 * from what it trusts (its own budget read), not text that came back from a
 * failed call. The sentence is the turn's reply, so it leaves through the
 * adapters' outbound filter like any other.
 *
 * Absent, or answering `undefined`, the reply is the catalogue's
 * `usageLimitReply` as before.
 */
export interface UsageLimitNoticeRequest {
  /** The caller, at the tier the turn ran at. */
  readonly caller: CallerContext;
}

export type UsageLimitNoticeResolver = (
  request: UsageLimitNoticeRequest,
) => string | undefined | Promise<string | undefined>;

/** How long the resolver may take. The person is already waiting on a failed turn. */
export const USAGE_LIMIT_NOTICE_TIMEOUT_MS = 3_000;
/** The longest sentence taken. Longer is a bug in the module, and the default is said. */
export const USAGE_LIMIT_NOTICE_MAX_CHARS = 600;

let resolver: UsageLimitNoticeResolver | null = null;

/** Once per process, from the `usageLimitNotice` manifest field. */
export function registerUsageLimitNoticeResolver(next: UsageLimitNoticeResolver): void {
  if (resolver)
    throw new Error('usage limit notice resolver already registered — it cannot be swapped after boot');
  resolver = next;
}

/** Test seam only. */
export function resetUsageLimitNoticeResolverForTest(): void {
  resolver = null;
}

// Tab, newline and carriage return are a sentence's own; every other control character is not.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * The module's sentence for this caller, or `undefined` for the default.
 * Never throws and never waits past the timeout: a resolver that throws, is
 * slow, or answers anything but a plain bounded sentence gets the default.
 */
export async function resolveUsageLimitNotice(
  request: UsageLimitNoticeRequest,
  timeoutMs: number = USAGE_LIMIT_NOTICE_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!resolver) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer: unknown = await Promise.race([
      Promise.resolve().then(() => resolver?.(request)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          logger.warn({ timeoutMs }, 'Usage limit notice resolver timed out; the default notice is used');
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
    if (answer === undefined) return undefined;
    if (typeof answer !== 'string') {
      logger.warn(
        'Usage limit notice resolver answered something that is not text; the default notice is used',
      );
      return undefined;
    }
    const text = answer.trim();
    if (text === '' || text.length > USAGE_LIMIT_NOTICE_MAX_CHARS || CONTROL.test(text)) {
      logger.warn(
        { length: text.length },
        'Usage limit notice resolver answered an empty, over-long or malformed sentence; the default notice is used',
      );
      return undefined;
    }
    return text;
  } catch (err) {
    logger.warn({ err }, 'Usage limit notice resolver failed; the default notice is used');
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
