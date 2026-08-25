import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// Pins for the slash-dispatch gates (src/platforms/discord/slashDispatch.ts,
// audit S5). A slash interaction never passes through Router.handle(), so the
// router's pre-turn spine cannot gate it — handleInteraction mirrors the
// spine's leading steps itself, and these tests pin that a module handler is
// never reached without them. The command list and notice pack are synthetic,
// registered through the real APIs exactly as a module's manifest does.
import type { Interaction } from 'discord.js';
import type { SlashDispatchGates } from '../src/platforms/discord/slashDispatch.js';

const { registerCommands, bindDiscordCommand } = await import('../src/commands/registry.js');
const { handleInteraction } = await import('../src/platforms/discord/slashDispatch.js');
const { registerTestNoticePack } = await import('./fixtures/noticePack.js');

registerTestNoticePack();
registerCommands([{ name: 'ping', platforms: ['discord'] }]);

/** Every dispatch the bound handler received: the deps it was handed. */
const handled: Array<{ caller: { userId: string; role: string } }> = [];
bindDiscordCommand('ping', {
  build: () => ({ name: 'ping', description: 'test' }),
  handle: async (_interaction, deps) => {
    handled.push({ caller: deps.caller });
  },
});

/** A minimal chat-input interaction; `replies` records every reply payload. */
function fakeInteraction(userId: string, replies: unknown[] = []) {
  return {
    isChatInputCommand: () => true,
    commandName: 'ping',
    user: { id: userId },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as Interaction;
}

/** Benign defaults; each test overrides the gate it is exercising. */
function gates(overrides: Partial<SlashDispatchGates> = {}): SlashDispatchGates {
  return {
    isUserBlockedFn: async () => false,
    isPausedFn: async () => false,
    resolveRoleFn: async () => 'member' as const,
    ...overrides,
  };
}

const deps = { filtered: async (text: string) => `[filtered]${text}` };

test("SECURITY: a blocked caller's interaction never reaches the handler and gets no reply — zero footprint, matching the router's block-list step", async () => {
  handled.length = 0;
  const replies: unknown[] = [];
  await handleInteraction(
    fakeInteraction('blocked-user', replies),
    deps,
    gates({ isUserBlockedFn: async () => true }),
  );
  assert.equal(handled.length, 0, 'the bound handler must never run for a blocked caller');
  assert.equal(replies.length, 0, 'a blocked caller gets silence, not a reply that confirms the block');
});

test('SECURITY: pause refuses dispatch for every tier below super_admin, with an ephemeral notice through the outbound filter', async () => {
  handled.length = 0;
  const replies: unknown[] = [];
  await handleInteraction(
    fakeInteraction('member-user', replies),
    deps,
    gates({ isPausedFn: async () => true }),
  );
  assert.equal(handled.length, 0, 'the bound handler must never run while paused');
  assert.equal(replies.length, 1, 'a paused caller gets exactly one notice');
  const reply = replies[0] as { content: string; flags: unknown };
  assert.ok(
    reply.content.startsWith('[filtered]'),
    'the pause notice must pass through deps.filtered like every slash reply',
  );
  assert.ok(reply.content.includes('pauseNotice'), 'the notice body comes from the registered pack');
  assert.notEqual(reply.flags, undefined, 'the notice must be ephemeral, not broadcast to the channel');
});

test('SECURITY: a super admin passes the pause gate — pausing must never lock out the tier that can resume', async () => {
  handled.length = 0;
  await handleInteraction(
    fakeInteraction('super-admin-user'),
    deps,
    gates({ isPausedFn: async () => true, resolveRoleFn: async () => 'super_admin' as const }),
  );
  assert.equal(handled.length, 1, 'the handler must run for a super admin even while paused');
  assert.equal(handled[0]?.caller.role, 'super_admin');
});

test('SECURITY: the handler receives the dispatcher-resolved tier on deps.caller — identity from the platform envelope, never from interaction content', async () => {
  handled.length = 0;
  await handleInteraction(
    fakeInteraction('admin-user'),
    deps,
    gates({ resolveRoleFn: async () => 'admin' as const }),
  );
  assert.deepEqual(handled[0]?.caller, { userId: 'admin-user', role: 'admin' });
});

test('SECURITY: role resolution failure fails CLOSED to guest, same as the router spine', async () => {
  handled.length = 0;
  await handleInteraction(
    fakeInteraction('unresolvable-user'),
    deps,
    gates({
      resolveRoleFn: async () => {
        throw new Error('db down');
      },
    }),
  );
  assert.equal(handled[0]?.caller.role, 'guest', 'an unresolvable caller must be treated as guest');
});

test('a block-list read failure fails OPEN (log and dispatch) — one failed check must never itself become an outage', async () => {
  handled.length = 0;
  await handleInteraction(
    fakeInteraction('some-user'),
    deps,
    gates({
      isUserBlockedFn: async () => {
        throw new Error('db down');
      },
    }),
  );
  assert.equal(handled.length, 1, 'the router treats a failed block-list read as not blocked; so does this');
});
