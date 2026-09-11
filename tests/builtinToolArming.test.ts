import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const {
  ALL_BUILTIN_TOOLS,
  MUTATING_BUILTIN_TOOLS,
  READ_ONLY_BUILTIN_TOOLS,
  SHELL_ARM_TTL_MS,
  armMutatingTools,
  armedSecondsRemaining,
  classifyArmingReply,
  disarmMutatingTools,
  isMutatingArmed,
  resetArmingsForTest,
  sweepExpiredArmings,
} = await import('../src/agent/builtinTools.js');

beforeEach(() => resetArmingsForTest());

test('the mutating set is exactly the four host-changing built-ins, and is disjoint from the read-only set', () => {
  assert.deepEqual([...MUTATING_BUILTIN_TOOLS], ['Bash', 'Write', 'Edit', 'NotebookEdit']);
  for (const tool of MUTATING_BUILTIN_TOOLS) {
    assert.ok(!READ_ONLY_BUILTIN_TOOLS.includes(tool), `${tool} must not be in the read-only set`);
  }
  assert.equal(ALL_BUILTIN_TOOLS.length, READ_ONLY_BUILTIN_TOOLS.length + MUTATING_BUILTIN_TOOLS.length);
});

test('SECURITY: the mutating built-ins are NOT armed by default — an unarmed turn can never reach a shell', () => {
  assert.equal(isMutatingArmed('discord', 'c1', 'sa-1'), false);
  assert.equal(armedSecondsRemaining('discord', 'c1', 'sa-1'), 0);
});

test('arming lasts for the advertised window and can be ended early', () => {
  armMutatingTools('discord', 'c1', 'sa-1');
  assert.equal(isMutatingArmed('discord', 'c1', 'sa-1'), true);
  const left = armedSecondsRemaining('discord', 'c1', 'sa-1');
  assert.ok(left > 0 && left <= SHELL_ARM_TTL_MS / 1000, `seconds remaining was ${left}`);
  assert.equal(disarmMutatingTools('discord', 'c1', 'sa-1'), true, 'disarm reports it was live');
  assert.equal(isMutatingArmed('discord', 'c1', 'sa-1'), false);
  assert.equal(disarmMutatingTools('discord', 'c1', 'sa-1'), false, 'a second disarm reports nothing live');
});

test('SECURITY: an arming is scoped to one actor in one conversation on one platform', () => {
  armMutatingTools('discord', 'c1', 'sa-1');
  assert.equal(isMutatingArmed('discord', 'c1', 'sa-2'), false, 'another actor is never armed');
  assert.equal(isMutatingArmed('discord', 'c2', 'sa-1'), false, 'another conversation is never armed');
  assert.equal(isMutatingArmed('whatsapp', 'c1', 'sa-1'), false, 'another platform is never armed');
});

test('SECURITY: an arming expires on its own, and the sweep drops the entry', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  armMutatingTools('discord', 'c1', 'sa-1');
  assert.equal(isMutatingArmed('discord', 'c1', 'sa-1'), true);
  t.mock.timers.tick(SHELL_ARM_TTL_MS + 1);
  assert.equal(isMutatingArmed('discord', 'c1', 'sa-1'), false, 'the window is not open forever');
  assert.equal(armedSecondsRemaining('discord', 'c1', 'sa-1'), 0);
  armMutatingTools('discord', 'c2', 'sa-1');
  t.mock.timers.tick(SHELL_ARM_TTL_MS + 1);
  sweepExpiredArmings();
  assert.equal(isMutatingArmed('discord', 'c2', 'sa-1'), false);
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
