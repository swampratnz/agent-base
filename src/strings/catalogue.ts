/**
 * Language/style notice catalogue — the base-owned MECHANISM half of the
 * `strings` extension point. One place implements the variant-selection
 * precedence, over OPEN axes a module registers, so no locale value is ever
 * named in framework code.
 *
 * The precedence:
 *
 *   1. a registered LANGUAGE the caller has set claims the turn — the
 *      entry's variant for it if one exists, else the base (default) text.
 *      The style axis is never consulted once a registered language is set,
 *      and an entry with no variant for that language falls back to the base
 *      text rather than sideways into a style variant;
 *   2. otherwise a registered STYLE selects its variant if the entry has
 *      one, else the base text;
 *   3. otherwise the base text. Values that mean "default" — the standing
 *      preference defaults, and any value a module chose not to register —
 *      are simply not registered axis values, so they land here.
 *
 * Trust level: every value in a pack is a fixed, human-authored literal —
 * no model call, no translation, no runtime input — and everything selected
 * here still leaves through the adapters' outbound filter (`filtered()`), so
 * the catalogue adds no egress path.
 */

/** What the caller has standing preferences for. Open strings on purpose —
 * see the axis-registration note above. The stored values are shape-checked
 * (a DB CHECK plus `assertPreferenceValue`), and a module's own
 * `set_language_preference`/`set_response_style` tool input enums stay
 * CLOSED — a closed MODEL-facing enum is the security invariant, and it
 * belongs where the module's axis values are known. */
export interface NoticeSelection {
  language?: string;
  style?: string;
}

/**
 * One notice: a base (English/default) value plus optional per-axis-value
 * variants. `T` is a plain string for fixed notices, or a template function
 * for the few "translate the shell, interpolate the dynamic value unchanged"
 * notices (pending-notice descriptions, budget counts, snippet line counts).
 */
export interface NoticeEntry<T> {
  base: T;
  /** Variants keyed by a registered language axis value. */
  language?: Record<string, T>;
  /** Variants keyed by a registered style axis value. */
  style?: Record<string, T>;
}

export interface NoticeAxes {
  /** Language axis values that claim a turn outright. */
  languages: readonly string[];
  /** Style axis values that apply when no registered language did. */
  styles: readonly string[];
}

/**
 * Pure variant selection — the one implementation of the precedence rules
 * documented in the file header. Exported separately from the catalogue
 * factory so the table-driven equivalence test can drive it directly.
 */
export function selectNoticeVariant<T>(
  entry: NoticeEntry<T>,
  axes: NoticeAxes,
  selection?: NoticeSelection,
): T {
  const language = selection?.language;
  if (language !== undefined && axes.languages.includes(language)) {
    return entry.language?.[language] ?? entry.base;
  }
  const style = selection?.style;
  if (style !== undefined && axes.styles.includes(style)) {
    return entry.style?.[style] ?? entry.base;
  }
  return entry.base;
}

/** A notice value: fixed text, or a template function over dynamic values. */
export type NoticeValue = string | ((...args: never[]) => string);

/**
 * Per-id notice types — the type-side half of pack registration.
 *
 * In community-agent this interface was EMPTY and the consuming module
 * augmented it (`declare module './catalogue.js'`) over its own entry map.
 * That inversion cannot survive the lift: with no module in the tree, every
 * base call site resolved to `never` and base would not compile at all. So
 * base now DECLARES the ids it consumes, with their concrete value types
 * (`BASE_NOTICE_IDS` below is the runtime twin), and a pack supplies the
 * text. Modules may still augment this interface with ids of their own —
 * the base set is a floor, not a ceiling.
 *
 * Keeping the concrete types here is what lets `notice()` return a template
 * entry as its function type and a fixed entry as a string, with zero casts
 * at call sites.
 */
export interface NoticeIdMap {
  /** Deterministic acknowledgement reply for a pure ack ("thanks", "ok"). */
  ackReply: string;
  /** DM sent when the caller has exhausted the strike budget. */
  blockedDm: () => string;
  /** Reply to a CANCEL of a pending confirm-gated action. */
  cancelConfirm: string;
  /** Appended when the outbound code policy dropped a snippet entirely. */
  codeOmittedNote: string;
  /** Appended when the outbound code policy truncated a snippet to N lines. */
  codeTruncatedNote: (shown: number) => string;
  /** Translated shell for a `Done: ` confirm outcome. */
  confirmDonePrefix: string;
  /** Translated shell for a `Failed: ` confirm outcome. */
  confirmFailedPrefix: string;
  /** Notice sent when the shared daily LLM spend budget is exhausted. */
  dailyBudgetNotice: string;
  /** Trailer warning the caller how many replies they have left today. */
  dailyReplyBudgetWarning: (remaining: number) => string;
  /** Reply confirming an escalation to a human was raised. */
  escalationConfirmed: string;
  /** Suffix offering to escalate to a human after a failed turn. */
  escalationOfferSuffix: string;
  /** Reply when the guild-wide escalation rate cap is exhausted. */
  escalationRateLimited: string;
  /** Static fallback notice for a caller who is not a member. */
  gatedNotice: string;
  /**
   * The dynamic gated notice, given an already-sanitised, already-capped,
   * already-joined list of admin display names. Base owns resolving,
   * sanitising, capping and joining; the SENTENCE around the names is the
   * module's, because it is deployment prose.
   */
  gatedNoticeWithAdmins: (admins: string) => string;
  /** Returning-guest "you first asked N days ago" clause. */
  gatedWaitClause: (notice: string, waitDays?: number) => string;
  /**
   * Heading joining a conduct-guidelines block onto a welcome or gated
   * notice — community-agent hardcoded the literal `Community guidelines:`
   * in four places (the router plus all three adapters). A framework cannot
   * assume the deployment has a "community", so the label is the module's.
   */
  guidelinesHeading: string;
  /** Nudge appended to a guest's deterministic knowledge-shortcut answer. */
  guestKnowledgeShortcutNudge: string;
  /** Reply when the turn failed for an internal reason. */
  internalErrorReply: string;
  /** Suffix appended to a deterministic knowledge-shortcut answer. */
  knowledgeShortcutSuffix: string;
  /** Reply when the turn hit its max-turns ceiling. */
  maxTurnsReply: string;
  /** Notice sent while the bot is paused by an operator. */
  pauseNotice: string;
  /** The CONFIRM/CANCEL prompt for a pending destructive action. */
  pendingNotice: (description: string) => string;
  /** Reply when the actor's tier changed inside a pending action's TTL. */
  permissionsChanged: string;
  /** Notice sent when the caller trips the per-caller message rate limit. */
  rateLimitNotice: string;
  /** Notice for a repeated max-turns failure answered from the shortcut cache. */
  repeatMaxTurnsShortcutNotice: string;
  /** Notice for a repeated question answered from the shortcut cache. */
  repeatShortcutNotice: string;
  /** Reply when the turn failed upstream after retries. */
  turnFailedReply: string;
  /** Reply when the shared upstream usage limit is hit. */
  usageLimitReply: string;
  /** As `usageLimitReply`, but stating that admins have been notified. */
  usageLimitReplyAdminNotified: string;
  /** Caveat appended to a transcribed voice note. */
  voiceLanguageCaveat: string;
  /** DM sent when a moderator warning is recorded (active/limit). */
  warnDm: (active: number, limit: number) => string;
}

/**
 * The runtime twin of `NoticeIdMap`'s base half — the ids `registerNoticePack`
 * insists on. It exists so a missing id is a REGISTRATION-time throw naming
 * every gap at once (see `createAgent`, which registers before any turn can
 * run) rather than a first-use throw in front of a member, months later, on
 * whichever notice happened to be missed. Keep it in sync with the interface
 * above; `tests/noticeCatalogue.test.ts` pins that they match.
 */
export const BASE_NOTICE_IDS = [
  'ackReply',
  'blockedDm',
  'cancelConfirm',
  'codeOmittedNote',
  'codeTruncatedNote',
  'confirmDonePrefix',
  'confirmFailedPrefix',
  'dailyBudgetNotice',
  'dailyReplyBudgetWarning',
  'escalationConfirmed',
  'escalationOfferSuffix',
  'escalationRateLimited',
  'gatedNotice',
  'gatedNoticeWithAdmins',
  'gatedWaitClause',
  'guestKnowledgeShortcutNudge',
  'guidelinesHeading',
  'internalErrorReply',
  'knowledgeShortcutSuffix',
  'maxTurnsReply',
  'pauseNotice',
  'pendingNotice',
  'permissionsChanged',
  'rateLimitNotice',
  'repeatMaxTurnsShortcutNotice',
  'repeatShortcutNotice',
  'turnFailedReply',
  'usageLimitReply',
  'usageLimitReplyAdminNotified',
  'voiceLanguageCaveat',
  'warnDm',
] as const;

let registered: { axes: NoticeAxes; entries: Record<string, NoticeEntry<NoticeValue>> } | null = null;

/**
 * Register THE notice pack, exactly once per process — called by the module's
 * pack, ordinarily through `createAgent`, before anything that can serve a
 * turn. A second registration throws rather than swapping packs after boot,
 * matching `registerToolTiers` (auth/rbac.ts) and the
 * skills-manifest/prompt-sections registries.
 *
 * FAIL-CLOSED on completeness: a pack missing any of `BASE_NOTICE_IDS` is
 * rejected here, listing every gap, because base code serves those ids on
 * paths a module author will not necessarily exercise before shipping.
 */
export function registerNoticePack(
  axes: NoticeAxes,
  entries: Record<string, NoticeEntry<NoticeValue>>,
): void {
  if (registered) {
    throw new Error('notice pack already registered — the pack cannot be swapped after boot');
  }
  const missing = BASE_NOTICE_IDS.filter((id) => entries[id] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `notice pack is missing ${missing.length} notice id(s) the base serves: ${missing.join(', ')}`,
    );
  }
  registered = { axes, entries };
}

/** Whether a pack has been registered — the readiness probe `createAgent` uses. */
export function isNoticePackRegistered(): boolean {
  return registered !== null;
}

/**
 * Test-only reset. Registration is deliberately once-per-process, but a test
 * file that drives registration itself needs to undo it; nothing in the
 * shipped runtime calls this.
 */
export function resetNoticePackForTests(): void {
  registered = null;
}

/**
 * Is `language` an axis value the registered pack actually varies on?
 *
 * This is the generic replacement for the single-locale branches base used
 * to carry. Base code asks "does the caller's standing preference name a
 * registered language variant?", never "is the caller a speaker of <locale>"
 * — one module may register a language, another none at all, and base
 * behaves correctly either way. The default preference values are not
 * registered by convention: they mean "no variant".
 *
 * Precedence is unchanged from `selectNoticeVariant`: a registered language
 * claims the turn, so a caller with one never pays the style lookup.
 */
export function isRegisteredLanguage(language: string | undefined): boolean {
  return language !== undefined && (registered?.axes.languages.includes(language) ?? false);
}

/** As `isRegisteredLanguage`, for the style axis. */
export function isRegisteredStyle(style: string | undefined): boolean {
  return style !== undefined && (registered?.axes.styles.includes(style) ?? false);
}

/**
 * `notice(id, {language, style})` — the one selection point, reading the
 * registered pack. Pass the caller's standing preferences RAW
 * (`'auto'`/`'en'`/`'standard'` mean "default" because they are not
 * registered axis values); never pre-resolve the precedence at a call site.
 * FAILS LOUD — never a silent empty string — if no pack was registered.
 *
 * Call it AT THE CALL SITE, per turn. Base deliberately no longer derives
 * module-scope `const X = notice(...)` values: that made merely importing a
 * base module throw unless a pack had already been registered, which is
 * unimplementable for a package whose entry point is `createAgent`.
 */
export function notice<K extends keyof NoticeIdMap>(id: K, selection?: NoticeSelection): NoticeIdMap[K] {
  if (!registered) {
    throw new Error(
      'no notice pack registered — a module must register one (createAgent does this) before requesting a notice',
    );
  }
  const entry = registered.entries[id as string];
  if (!entry) {
    throw new Error(`unknown notice id: ${String(id)} — not present in the registered pack`);
  }
  return selectNoticeVariant(entry, registered.axes, selection) as NoticeIdMap[K];
}
