import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { registerPurgeContributor } from '../lifecycle.js';

/**
 * Standing per-member preferences: response style (issue #126) and language
 * (issue #189). Both are single primary-key lookups on the hot path — every
 * turn reads them — so both reads deliberately DEGRADE TO THE DEFAULT rather
 * than throwing when the DB hiccups (issue #52's fail-open convention, shared
 * with getCodeAnswersPolicy): a preference lookup must never be what fails a
 * reply. The writes are plain upserts and are allowed to throw.
 *
 * Extracted verbatim from repository.ts (see repository.ts's header for why the
 * split exists); `repository.ts` re-exports everything here, so every existing
 * import site is unchanged.
 */

// --- Standing response-style preference (issue #126) ------------------------

/**
 * A standing reply-style value. An OPEN string, not a closed union:
 * community-agent's `'standard' | 'plain'` baked one deployment's style axis
 * into the framework. `'standard'` is the base-owned default and means "no
 * style variant"; every other value is a module's, and both the notice
 * catalogue and the prompt-section maps ignore values they don't recognise,
 * so an unknown value degrades to the default rather than breaking a reply.
 *
 * The write path is still constrained — `assertPreferenceValue` below plus
 * the DB's shape CHECK — and the MODEL-facing input enum in the module's
 * `set_response_style` tool stays CLOSED, which is where that security
 * invariant belongs.
 */
export type ResponseStyle = string;

/** The base-owned default: no style variant selected. */
export const DEFAULT_RESPONSE_STYLE = 'standard';

/** The base-owned default: no standing language selected (per-message mirroring). */
export const DEFAULT_LANGUAGE_PREFERENCE = 'auto';

/**
 * Shape gate for a stored preference value, mirroring the DB CHECK. Not a
 * value allowlist — base cannot know a module's axis values — but a hard
 * bound on what can reach the column: a short, lowercase, hyphenated token
 * (BCP-47-ish for languages, a plain slug for styles). Anything else throws
 * rather than being written, so the column can never accumulate free text.
 */
const PREFERENCE_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertPreferenceValue(kind: 'language' | 'style', value: string): void {
  if (value.length > 32 || !PREFERENCE_VALUE.test(value)) {
    throw new Error(`invalid ${kind} preference value`);
  }
}

/**
 * The caller's standing response-style preference, or 'standard' (today's
 * default behaviour) when they've never called `set_response_style`. A
 * single primary-key lookup, so this is a negligible per-turn cost.
 */
export async function getResponseStyle(platform: Platform, userId: string): Promise<ResponseStyle> {
  try {
    const { rows } = await pool.query(
      `SELECT style FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const style = rows[0]?.style;
    return typeof style === 'string' && style.length > 0 ? style : DEFAULT_RESPONSE_STYLE;
  } catch (err) {
    // Hot-path read on every turn: a DB hiccup must not fail the turn (issue
    // #52) — degrade to the default reply style, same as getCodeAnswersPolicy.
    logger.warn({ err, platform, userId }, 'Response-style read failed; using the default');
    return DEFAULT_RESPONSE_STYLE;
  }
}

/** Upsert the caller's response-style preference. */
export async function setResponseStyle(
  platform: Platform,
  userId: string,
  style: ResponseStyle,
): Promise<void> {
  assertPreferenceValue('style', style);
  await pool.query(
    `INSERT INTO response_style_prefs (platform, user_id, style, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET style = $3, updated_at = now()`,
    [platform, userId, style],
  );
}

// --- Standing language preference (issue #189) -------------------------------

/** A standing reply-language value — an OPEN string, for the same reasons as
 * `ResponseStyle` above. `'auto'` is the base-owned default (per-message
 * mirroring); community-agent's closed `'auto' | 'en' | 'mi'` named a locale
 * in a framework type. */
export type LanguagePreference = string;

/**
 * The caller's standing language preference, or 'auto' (today's per-message
 * mirroring default, issue #68) when they've never called
 * `set_language_preference`. A single primary-key lookup, same cost shape as
 * getResponseStyle.
 */
export async function getLanguagePreference(platform: Platform, userId: string): Promise<LanguagePreference> {
  try {
    const { rows } = await pool.query(
      `SELECT language FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const language = rows[0]?.language;
    return typeof language === 'string' && language.length > 0 ? language : DEFAULT_LANGUAGE_PREFERENCE;
  } catch (err) {
    // Hot-path read on every turn: a DB hiccup must not fail the turn (issue
    // #52) — degrade to 'auto', same as getResponseStyle.
    logger.warn({ err, platform, userId }, 'Language-preference read failed; using the default');
    return DEFAULT_LANGUAGE_PREFERENCE;
  }
}

/** Upsert the caller's standing language preference. */
export async function setLanguagePreference(
  platform: Platform,
  userId: string,
  language: LanguagePreference,
): Promise<void> {
  assertPreferenceValue('language', language);
  await pool.query(
    `INSERT INTO language_prefs (platform, user_id, language, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET language = $3, updated_at = now()`,
    [platform, userId, language],
  );
}

// --- Lifecycle registration (storage/lifecycle.ts) ---------------------------

registerPurgeContributor({
  name: 'response_style_prefs',
  order: 70,
  async purge({ platform, userId }, tx) {
    // response_style_prefs (issue #126) is keyed the same way — purge coherence
    // for anyone who opted into the plain-language preference.
    const { rowCount: responseStyle } = await tx.query(
      `DELETE FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return responseStyle ?? 0;
  },
});

registerPurgeContributor({
  name: 'language_prefs',
  order: 80,
  async purge({ platform, userId }, tx) {
    // language_prefs (issue #189) is keyed the same way — purge coherence for
    // anyone who opted into a standing language preference.
    const { rowCount: languagePreference } = await tx.query(
      `DELETE FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    return languagePreference ?? 0;
  },
});
