import { test } from 'node:test';
import assert from 'node:assert/strict';

const ZONE = 'Pacific/Auckland';
const LOCALE = 'en-NZ';
// eventTime.ts reads DISPLAY_TIMEZONE/DISPLAY_LOCALE defaults off the config
// singleton, which validates env at import time — provide a dummy environment
// first, matching the convention in tests/configSlices.test.ts. These tests
// pass both values explicitly, so the defaults never decide an assertion.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { formatEventTime } = await import('../src/util/eventTime.js');

// formatEventTime (issue #577): minute-granularity, timezone-aware rendering
// for event start/end times shown to members and admins. The timezone and
// locale are CONFIG (DISPLAY_TIMEZONE/DISPLAY_LOCALE) — community-agent
// hardcoded Pacific/Auckland/en-NZ in this module — so these tests pass them
// explicitly rather than depending on the ambient env, and use the NZ pair to
// keep the DST assertions meaningful.

test('formatEventTime renders the same NZ-local instant from both an ISO string and a Date (issue #577)', () => {
  const iso = '2026-07-14T19:00:00.000Z';
  const fromString = formatEventTime(iso, LOCALE, ZONE);
  const fromDate = formatEventTime(new Date(iso), LOCALE, ZONE);
  assert.equal(fromString, fromDate, 'string and Date input for the same instant must render identically');
  assert.doesNotMatch(fromString, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'must not be a raw ISO timestamp');
  assert.doesNotMatch(fromString, /Z(?=[.\s]|$)/, 'must not be a bare Z-suffixed UTC timestamp');
});

test('the NZST/NZDT transition is handled by Intl, not a hard-coded offset (issue #577)', () => {
  // Same UTC wall-clock time-of-day (11:30 UTC): one NZST (winter, UTC+12)
  // instant and one NZDT (summer, UTC+13) instant. A hard-coded fixed offset
  // could not produce a different local time-of-day from the same UTC input.
  const winter = formatEventTime('2026-07-05T11:30:00.000Z', LOCALE, ZONE);
  const summer = formatEventTime('2026-01-05T11:30:00.000Z', LOCALE, ZONE);
  assert.notEqual(winter, summer, 'winter (NZST) and summer (NZDT) must render different local times');

  const expectedWinter = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date('2026-07-05T11:30:00.000Z'));
  const expectedSummer = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date('2026-01-05T11:30:00.000Z'));
  assert.equal(winter, expectedWinter);
  assert.equal(summer, expectedSummer);
});
