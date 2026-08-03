import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_NOTICE_IDS,
  isNoticePackRegistered,
  isRegisteredLanguage,
  isRegisteredStyle,
  notice,
  registerNoticePack,
  resetNoticePackForTests,
  selectNoticeVariant,
  type NoticeEntry,
  type NoticeValue,
} from '../src/strings/catalogue.js';
import { TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES } from './fixtures/noticePack.js';

/**
 * The notice catalogue after the base/module split (extraction §3, residue
 * item 1).
 *
 * community-agent inverted this: the interface was empty and the CONSUMING
 * module augmented it, while base derived module-scope `const X_MI =
 * notice(id, { language: 'mi' })` values at import time. Both had to go —
 * the first left every base call site typed `never` with no module in the
 * tree, and the second made merely IMPORTING a base module throw unless a
 * pack had already been registered, which a package whose entry point is
 * `createAgent` cannot arrange. These tests pin the replacement.
 */

test('selectNoticeVariant: a registered language claims the turn; style is never consulted after it', () => {
  const entry: NoticeEntry<NoticeValue> = {
    base: 'base',
    language: { xx: 'lang' },
    style: { simple: 'style' },
  };
  assert.equal(selectNoticeVariant(entry, TEST_NOTICE_AXES, { language: 'xx', style: 'simple' }), 'lang');
  assert.equal(selectNoticeVariant(entry, TEST_NOTICE_AXES, { style: 'simple' }), 'style');
  assert.equal(selectNoticeVariant(entry, TEST_NOTICE_AXES, {}), 'base');
  // An UNregistered value means "default" — it must not select a variant.
  assert.equal(selectNoticeVariant(entry, TEST_NOTICE_AXES, { language: 'auto' }), 'base');
  // A registered language with no variant for it falls back to base, never
  // sideways into the style variant.
  assert.equal(
    selectNoticeVariant({ base: 'base', style: { simple: 'style' } }, TEST_NOTICE_AXES, {
      language: 'xx',
      style: 'simple',
    }),
    'base',
  );
});

test('SECURITY: registerNoticePack is fail-closed on the base id set — an incomplete pack is rejected, naming every gap', () => {
  resetNoticePackForTests();
  const incomplete = { ...TEST_NOTICE_ENTRIES };
  delete incomplete.pauseNotice;
  delete incomplete.warnDm;
  assert.throws(
    () => registerNoticePack(TEST_NOTICE_AXES, incomplete),
    (err: Error) =>
      /missing 2 notice id\(s\)/.test(err.message) &&
      err.message.includes('pauseNotice') &&
      err.message.includes('warnDm'),
    'a pack missing base ids must be rejected AT REGISTRATION, naming every gap — base serves these on ' +
      'paths (moderation DMs, pause shedding) a module author will not necessarily exercise before shipping, ' +
      'so first-use discovery means blank or throwing member-facing text in production',
  );
  assert.equal(isNoticePackRegistered(), false, 'a rejected pack must not be half-registered');
});

test('notice(): serves the registered pack, and throws rather than returning blank text', () => {
  resetNoticePackForTests();
  assert.equal(isNoticePackRegistered(), false);
  assert.throws(() => notice('pauseNotice'), /no notice pack registered/);

  registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
  assert.equal(isNoticePackRegistered(), true);
  assert.equal(notice('pauseNotice'), 'test:pauseNotice');
  assert.equal(notice('pauseNotice', { language: 'xx' }), 'test:pauseNotice:xx');
  assert.equal(notice('pauseNotice', { style: 'simple' }), 'test:pauseNotice:simple');
  // Template ids come back as their function type, not a string.
  assert.equal(notice('warnDm')(2, 3), 'test:warnDm:2/3');
  assert.equal(notice('warnDm', { language: 'xx' })(2, 3), 'xx|test:warnDm:2/3');
});

test('registerNoticePack refuses a second registration — a pack cannot be swapped after boot', () => {
  resetNoticePackForTests();
  registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
  assert.throws(
    () => registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES),
    /already registered/,
    'swapping the pack at runtime would let late code change what a member is told',
  );
});

test('every id in BASE_NOTICE_IDS is servable from a complete pack — the list and the interface agree', () => {
  resetNoticePackForTests();
  registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
  for (const id of BASE_NOTICE_IDS) {
    const value: unknown = notice(id);
    assert.ok(
      typeof value === 'string' || typeof value === 'function',
      `${id} must resolve to a string or a template function`,
    );
  }
  assert.equal(
    new Set(BASE_NOTICE_IDS).size,
    BASE_NOTICE_IDS.length,
    'BASE_NOTICE_IDS must not contain duplicates',
  );
  assert.deepEqual(
    [...BASE_NOTICE_IDS],
    [...BASE_NOTICE_IDS].sort(),
    'BASE_NOTICE_IDS is kept sorted so two PRs adding different ids land in different hunks',
  );
});

test('isRegisteredLanguage/isRegisteredStyle: the axis probe base uses instead of naming a locale', () => {
  resetNoticePackForTests();
  // Fail-safe before registration: nothing is a registered variant, so base
  // takes its default path rather than throwing on a probe.
  assert.equal(isRegisteredLanguage('xx'), false);
  assert.equal(isRegisteredStyle('simple'), false);

  registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
  assert.equal(isRegisteredLanguage('xx'), true);
  assert.equal(isRegisteredLanguage('auto'), false, 'the default preference value is not an axis value');
  assert.equal(isRegisteredLanguage(undefined), false);
  assert.equal(isRegisteredStyle('simple'), true);
  assert.equal(isRegisteredStyle('standard'), false, 'the default style is not an axis value');
  assert.equal(isRegisteredStyle(undefined), false);
});
