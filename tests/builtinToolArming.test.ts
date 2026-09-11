import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const {
  ALL_BUILTIN_TOOLS,
  MUTATING_BUILTIN_TOOLS,
  NON_MUTATING_BUILTIN_TOOLS,
  SHELL_ARM_TTL_MS,
  armMutatingTools,
  armedSecondsRemaining,
  classifyArmingReply,
  disarmMutatingTools,
  isMutatingArmed,
  resetArmingsForTest,
  sweepExpiredArmings,
} = await import('../src/agent/builtinTools.js');
const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { buildQueryOptions } = await import('../src/agent/core.js');

// The synthetic tier set, registered the way a module's manifest does, so
// buildQueryOptions can be called here (same shape as tests/toolLockdown).
registerToolTiers({ member: ['mcp__t__ask'], admin: [], superAdmin: [], discordOnly: [] });
registerFlaggedToolPredicates([]);

const ACTOR = 'sa-1';
const CONVO = 'c1';

beforeEach(() => resetArmingsForTest());

function optionsFor(armed: boolean) {
  if (armed) armMutatingTools('discord', CONVO, ACTOR);
  return buildQueryOptions('super_admin', 'system prompt', {}, null, CONVO, 'discord', ACTOR);
}

/** The gate's own hook callback, as buildQueryOptions wires it for this turn. */
function gateHook(opts: ReturnType<typeof optionsFor>) {
  const entries = (
    opts as {
      hooks?: { PreToolUse?: Array<{ matcher: string; hooks: Array<(i: unknown) => Promise<unknown>> }> };
    }
  ).hooks?.PreToolUse;
  const entry = entries?.find((e) => e.matcher === MUTATING_BUILTIN_TOOLS.join('|'));
  assert.ok(entry, 'the mutating-tool gate must be attached to a super-admin turn');
  return entry.hooks[0];
}

function decisionOf(result: unknown): string | undefined {
  return (result as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput
    ?.permissionDecision;
}

test('the tool sets are disjoint, and the mutating set is exactly the four host-changing built-ins', () => {
  assert.deepEqual([...MUTATING_BUILTIN_TOOLS], ['Bash', 'Write', 'Edit', 'NotebookEdit']);
  for (const tool of MUTATING_BUILTIN_TOOLS) {
    assert.ok(!NON_MUTATING_BUILTIN_TOOLS.includes(tool), `${tool} must not be in the non-mutating set`);
  }
  assert.equal(ALL_BUILTIN_TOOLS.length, NON_MUTATING_BUILTIN_TOOLS.length + MUTATING_BUILTIN_TOOLS.length);
});

test('SECURITY: an UNARMED super-admin turn gets the pre-change surface — no shell, no Read, no WebFetch, no Task', () => {
  // The correction from review: gating only the mutating four left Read +
  // WebFetch granted and auto-approved in every super-admin turn, which is a
  // read-anything-then-send-anywhere pair needing no arming at all.
  const opts = optionsFor(false);
  assert.deepEqual(opts.tools, ['WebSearch'], 'built-ins for an unarmed super admin are exactly [WebSearch]');
  assert.ok(opts.disallowedTools.includes('WebFetch'), 'WebFetch stays disallowed while unarmed');
  assert.ok(opts.disallowedTools.includes('Task'), 'Task stays disallowed while unarmed');
  for (const tool of [...MUTATING_BUILTIN_TOOLS, 'Read', 'Glob', 'Grep']) {
    assert.ok(!opts.allowedTools.includes(tool), `${tool} must not be pre-approved while unarmed`);
  }
  assert.ok(!('cwd' in opts), 'an unarmed turn carries no cwd');
  assert.ok(!('env' in opts), 'an unarmed turn carries no env override');
});

test('an ARMED super-admin turn gets the full built-in surface', () => {
  const opts = optionsFor(true);
  for (const tool of ALL_BUILTIN_TOOLS) {
    assert.ok(opts.tools.includes(tool), `${tool} must be granted inside an armed window`);
    assert.ok(opts.allowedTools.includes(tool), `${tool} must be pre-approved inside an armed window`);
  }
  assert.deepEqual(opts.disallowedTools, [], 'nothing is disallowed inside an armed window');
  assert.ok('cwd' in opts, 'an armed turn carries a working directory');
});

test('SECURITY: the gate DENIES a mutating tool when the window is not open', async () => {
  // Pins the behaviour, not just the matcher string: the first version of this
  // change asserted only that a matcher was present, so a refactor returning
  // an unconditional allow would have passed every pin.
  const armedOpts = optionsFor(true);
  const hook = gateHook(armedOpts);
  disarmMutatingTools('discord', CONVO, ACTOR);
  const denied = await hook({ tool_name: 'Bash' });
  assert.equal(decisionOf(denied), 'deny', 'a mid-turn expiry/disarm must deny the call');
  assert.match(
    String(
      (denied as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
        ?.permissionDecisionReason,
    ),
    /arm shell/,
    'the denial must say how a human can authorise it',
  );
});

test('SECURITY: the gate ALLOWS a mutating tool only while the window is open', async () => {
  const hook = gateHook(optionsFor(true));
  const allowed = await hook({ tool_name: 'Bash' });
  assert.equal(decisionOf(allowed), undefined, 'an armed call is not denied');
  assert.deepEqual(allowed, { continue: true });
});

test('SECURITY: the mutating built-ins are not armed by default, and arming is scoped to one actor/conversation/platform', () => {
  assert.equal(isMutatingArmed('discord', CONVO, ACTOR), false);
  armMutatingTools('discord', CONVO, ACTOR);
  assert.equal(isMutatingArmed('discord', CONVO, 'sa-2'), false, 'another actor is never armed');
  assert.equal(isMutatingArmed('discord', 'c2', ACTOR), false, 'another conversation is never armed');
  assert.equal(isMutatingArmed('whatsapp', CONVO, ACTOR), false, 'another platform is never armed');
});

test('arming lasts for the advertised window and can be ended early', () => {
  armMutatingTools('discord', CONVO, ACTOR);
  const left = armedSecondsRemaining('discord', CONVO, ACTOR);
  assert.ok(left > 0 && left <= SHELL_ARM_TTL_MS / 1000, `seconds remaining was ${left}`);
  assert.equal(disarmMutatingTools('discord', CONVO, ACTOR), true, 'disarm reports it was live');
  assert.equal(isMutatingArmed('discord', CONVO, ACTOR), false);
  assert.equal(disarmMutatingTools('discord', CONVO, ACTOR), false, 'a second disarm reports nothing live');
});

test('SECURITY: an arming expires on its own, and a sweep keeps live armings while dropping dead ones', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  armMutatingTools('discord', 'expiring', ACTOR);
  t.mock.timers.tick(SHELL_ARM_TTL_MS + 1);
  armMutatingTools('discord', 'fresh', ACTOR);
  sweepExpiredArmings();
  assert.equal(isMutatingArmed('discord', 'expiring', ACTOR), false, 'the window is not open forever');
  assert.equal(armedSecondsRemaining('discord', 'expiring', ACTOR), 0);
  assert.equal(isMutatingArmed('discord', 'fresh', ACTOR), true, 'the sweep must not drop a live arming');
});

test('SECURITY: only a deliberate arming phrase classifies — ordinary talk about arming never does', () => {
  assert.equal(classifyArmingReply('arm shell'), 'arm');
  assert.equal(classifyArmingReply('  ARM SHELL  '), 'arm');
  assert.equal(classifyArmingReply('<@1234> arm shell'), 'arm', 'a Discord mention prefix is tolerated');
  assert.equal(classifyArmingReply('@dave arm shell'), 'arm', 'a WhatsApp mention prefix is tolerated');
  assert.equal(classifyArmingReply('disarm shell'), 'disarm');
  for (const text of [
    'can you arm shell for me?',
    'arm shell please',
    'I armed the shell earlier',
    'arm shellfish',
    'shell',
    '',
  ]) {
    assert.equal(classifyArmingReply(text), null, `must not classify: ${JSON.stringify(text)}`);
  }
});
