import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// The module's own sentence for a usage-limit failure (WattoBot BASE-GAPS 27):
// asked with the caller only, bounded, and never a way to fail the reply.
const {
  registerUsageLimitNoticeResolver,
  resetUsageLimitNoticeResolverForTest,
  resolveUsageLimitNotice,
  USAGE_LIMIT_NOTICE_MAX_CHARS,
} = await import('../src/agent/usageLimitNotice.js');
type Caller = Parameters<typeof resolveUsageLimitNotice>[0]['caller'];

const caller = {
  platform: 'web',
  userId: 'u1',
  role: 'member',
  conversationId: 'c1',
} as unknown as Caller;

beforeEach(() => resetUsageLimitNoticeResolverForTest());

test('with no resolver, or one that answers undefined, the default notice stands', async () => {
  assert.equal(await resolveUsageLimitNotice({ caller }), undefined);
  registerUsageLimitNoticeResolver(() => undefined);
  assert.equal(await resolveUsageLimitNotice({ caller }), undefined);
});

test('the resolver is registered once per process', () => {
  registerUsageLimitNoticeResolver(() => undefined);
  assert.throws(() => registerUsageLimitNoticeResolver(() => 'x'), /already registered/);
});

test("the module's sentence is the answer, trimmed, sync or async", async () => {
  registerUsageLimitNoticeResolver(({ caller: c }) => `  ${c.userId}: resets on Monday.\n`);
  assert.equal(await resolveUsageLimitNotice({ caller }), 'u1: resets on Monday.');
  resetUsageLimitNoticeResolverForTest();
  registerUsageLimitNoticeResolver(async () => 'It resets on Monday 28 September.');
  assert.equal(await resolveUsageLimitNotice({ caller }), 'It resets on Monday 28 September.');
});

test('SECURITY: the resolver is handed the caller and nothing else, so it cannot echo the failed call', async () => {
  let seen: unknown;
  registerUsageLimitNoticeResolver((request) => {
    seen = request;
    return 'ok';
  });
  await resolveUsageLimitNotice({ caller });
  assert.deepEqual(Object.keys(seen as object), ['caller']);
  // The one call site passes the caller alone: the thrown error's message never reaches a module.
  const core = readFileSync(new URL('../src/agent/core.ts', import.meta.url), 'utf8');
  const calls = core.match(/resolveUsageLimitNotice\([^)]*\)/g) ?? [];
  assert.deepEqual(calls, ['resolveUsageLimitNotice({ caller })']);
});

test('SECURITY: a resolver that throws, stalls, or answers badly gets the default notice, never a failed reply', async () => {
  const bad: Array<() => unknown> = [
    () => {
      throw new Error('boom');
    },
    () => Promise.reject(new Error('boom')),
    () => '',
    () => '   ',
    () => 42,
    () => ({ text: 'x' }),
    () => null,
    () => 'x'.repeat(USAGE_LIMIT_NOTICE_MAX_CHARS + 1),
    () => 'bell\u0007',
    () => 'escape\u001b[31m',
  ];
  for (const resolver of bad) {
    resetUsageLimitNoticeResolverForTest();
    registerUsageLimitNoticeResolver(resolver as never);
    assert.equal(await resolveUsageLimitNotice({ caller }), undefined, resolver.toString());
  }
  resetUsageLimitNoticeResolverForTest();
  registerUsageLimitNoticeResolver(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await resolveUsageLimitNotice({ caller }, 30), undefined);
  assert.ok(Date.now() - started < 1_000, 'it does not wait past its timeout');
  // A sentence at the limit, with a line break, is a sentence.
  resetUsageLimitNoticeResolverForTest();
  const longest = `${'x'.repeat(USAGE_LIMIT_NOTICE_MAX_CHARS - 2)}\ny`;
  registerUsageLimitNoticeResolver(() => longest);
  assert.equal(await resolveUsageLimitNotice({ caller }), longest);
});
