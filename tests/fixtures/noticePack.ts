import {
  registerNoticePack,
  BASE_NOTICE_IDS,
  type NoticeAxes,
  type NoticeEntry,
  type NoticeValue,
} from '../../src/strings/catalogue.js';

/**
 * A complete, deliberately BORING notice pack for tests.
 *
 * Base declares which notice ids it serves (`BASE_NOTICE_IDS`) but ships no
 * text — text is a module's. Any test that exercises a base path which serves
 * a notice therefore has to register a pack first, and it must be a COMPLETE
 * one, because `registerNoticePack` is fail-closed on the base set.
 *
 * The values here are marker strings rather than plausible prose, on purpose:
 * a test asserting on `test:pauseNotice` is obviously asserting on the
 * plumbing, not smuggling one deployment's copy back into the framework's
 * test suite.
 *
 * Two axis values are registered so the precedence rules are exercisable
 * without naming a real locale: language `'xx'` and style `'simple'`.
 */
export const TEST_NOTICE_AXES: NoticeAxes = {
  languages: ['xx'],
  styles: ['simple'],
};

/** A fixed-string entry with both variants present. */
function fixed(id: string): NoticeEntry<NoticeValue> {
  return {
    base: `test:${id}`,
    language: { xx: `test:${id}:xx` },
    style: { simple: `test:${id}:simple` },
  };
}

/** A template entry: same marker, plus whatever the caller interpolates. */
function template(id: string, render: (...args: never[]) => string): NoticeEntry<NoticeValue> {
  return {
    base: render,
    language: { xx: ((...args: never[]) => `xx|${render(...args)}`) as NoticeValue },
    style: { simple: ((...args: never[]) => `simple|${render(...args)}`) as NoticeValue },
  };
}

const TEMPLATES: Readonly<Record<string, (...args: never[]) => string>> = {
  blockedDm: () => 'test:blockedDm',
  codeTruncatedNote: (shown: number) => `test:codeTruncatedNote:${shown}`,
  dailyReplyBudgetWarning: (remaining: number) => `test:dailyReplyBudgetWarning:${remaining}`,
  gatedNoticeWithAdmins: (admins: string) => `test:gatedNoticeWithAdmins:${admins}`,
  // Mirrors the real contract: a falsy/sub-one waitDays is a no-op passthrough.
  gatedWaitClause: (text: string, waitDays?: number) =>
    !waitDays || waitDays < 1 ? text : `${text} (waited ${Math.floor(waitDays)})`,
  pendingNotice: (description: string) => `test:pendingNotice:${description}:CONFIRM/CANCEL`,
  warnDm: (active: number, limit: number) => `test:warnDm:${active}/${limit}`,
};

export const TEST_NOTICE_ENTRIES: Record<string, NoticeEntry<NoticeValue>> = Object.fromEntries(
  BASE_NOTICE_IDS.map((id) => [id, TEMPLATES[id] ? template(id, TEMPLATES[id]) : fixed(id)]),
);

/** Register the pack. Call once per test process, before anything serves a notice. */
export function registerTestNoticePack(): void {
  registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
}
