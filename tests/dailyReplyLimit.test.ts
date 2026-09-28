import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// The per-person daily reply ceiling: a module may move it per caller and
// never remove it, and a person over it is told so on every message, never
// met with silence.
const {
  registerDailyReplyLimitResolver,
  resetDailyReplyLimitResolverForTest,
  resolveDailyReplyLimit,
  overDailyReplyLimit,
} = await import('../src/dailyReplyLimit.js');
const { Router } = await import('../src/router.js');
const { config } = await import('../src/config.js');
const { registerTestNoticePack } = await import('./fixtures/noticePack.js');
type Tier = import('../src/auth/tiers.js').Tier;

registerTestNoticePack();

const web = { platform: 'web' as const, userId: 'u1', role: 'member' as Tier };

beforeEach(() => resetDailyReplyLimitResolverForTest());

test('with no resolver, or one that answers undefined, the deployment figure stands', () => {
  assert.equal(resolveDailyReplyLimit(web, 50), 50);
  registerDailyReplyLimitResolver(() => undefined);
  assert.equal(resolveDailyReplyLimit(web, 50), 50);
});

test('the resolver is registered once per process', () => {
  registerDailyReplyLimitResolver(() => 500);
  assert.throws(() => registerDailyReplyLimitResolver(() => 500), /already registered/);
});

test("the module's figure is the ceiling for the callers it names", () => {
  registerDailyReplyLimitResolver((r) => (r.platform === 'web' ? 500 : undefined));
  assert.equal(resolveDailyReplyLimit(web, 50), 500);
  assert.equal(resolveDailyReplyLimit({ ...web, platform: 'discord' }, 50), 50);
});

test('SECURITY: a resolver cannot remove the ceiling — zero, a fraction, a huge figure, a string or a throw all get the deployment figure', () => {
  for (const bad of [0, -1, 2.5, 100_001, Number.POSITIVE_INFINITY, Number.NaN, '500', null]) {
    resetDailyReplyLimitResolverForTest();
    registerDailyReplyLimitResolver(() => bad as unknown as number);
    assert.equal(resolveDailyReplyLimit(web, 50), 50, `answer ${String(bad)}`);
  }
  resetDailyReplyLimitResolverForTest();
  registerDailyReplyLimitResolver(() => {
    throw new Error('policy table unreachable');
  });
  assert.equal(resolveDailyReplyLimit(web, 50), 50);
});

test('over the ceiling is at it or past it; a super admin and a ceiling of 0 are never over', () => {
  assert.equal(overDailyReplyLimit(499, 500, 'member'), false);
  assert.equal(overDailyReplyLimit(500, 500, 'member'), true);
  assert.equal(overDailyReplyLimit(501, 500, 'admin'), true);
  assert.equal(overDailyReplyLimit(10_000, 500, 'super_admin'), false);
  assert.equal(overDailyReplyLimit(10_000, 0, 'member'), false);
});

/** The router's daily-budget step, run against a stand-in router whose reply count is `used`. */
async function runStep(
  used: number,
): Promise<{ outcome: string; sent: string[]; state: Record<string, unknown> }> {
  const sent: string[] = [];
  const self = {
    countReplies: async () => used,
    getLangPref: async () => 'auto',
    getRespStyle: async () => 'standard',
    send: (Router.prototype as unknown as { send: unknown }).send,
    budgetCheckFailureNotifiedAt: undefined,
    BUDGET_CHECK_FAILURE_ALERT_WINDOW_MS: 900_000,
  };
  const adapter = { sendMessage: async (m: { text: string }) => (sent.push(m.text), ['m1']) };
  const state: Record<string, unknown> = { role: 'member', userKey: 'web:u1' };
  const ctx = { msg: { platform: 'web', userId: 'u1', conversationId: 'c1' }, adapter, state };
  const step = (Router.prototype as unknown as { dailyBudgetStep: (c: unknown) => Promise<string> })
    .dailyBudgetStep;
  const outcome = await step.call(self, ctx);
  return { outcome, sent, state };
}

test('SECURITY: the ceiling holds, and every message over it is told so — never silence', async () => {
  const limit = config.behaviour.dailyReplyLimitPerUser;
  assert.ok(limit > 0, 'the test deployment has a ceiling');
  const under = await runStep(limit - 1);
  assert.equal(under.outcome, 'continue');
  assert.deepEqual(under.sent, []);
  assert.deepEqual(under.state.replyBudget, { used: limit - 1, limit });
  // Three messages in a row at the ceiling: each is refused, and each is answered.
  for (let i = 0; i < 3; i += 1) {
    const over = await runStep(limit + i);
    assert.equal(over.outcome, 'handled', 'no turn runs past the ceiling');
    assert.deepEqual(over.sent, ['test:dailyBudgetNotice'], `message ${i + 1} over the ceiling is told`);
  }
});

test("SECURITY: a module's higher ceiling is a ceiling too", async () => {
  registerDailyReplyLimitResolver((r) => (r.platform === 'web' ? 500 : undefined));
  assert.equal((await runStep(499)).outcome, 'continue');
  const at = await runStep(500);
  assert.equal(at.outcome, 'handled');
  assert.deepEqual(at.sent, ['test:dailyBudgetNotice']);
});
