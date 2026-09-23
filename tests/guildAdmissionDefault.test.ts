import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// agent-base #65, the no-hook half: with no module supplying `admitGuild`, the
// Discord adapter must behave exactly as the single-guild adapter always has.
// Separate from guildAdmission.test.ts because the registry is once per process.
const HOME = '6510000000000000001';
const OTHER = '6510000000000000002';
const SUPER = '6510000000000000201';

process.env.DISCORD_GUILD_ID = HOME;
process.env.DISCORD_SLASH_COMMANDS_ENABLED = 'true';
process.env.SUPER_ADMIN_DISCORD_IDS = SUPER;
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

import { ChannelType, type Client, type Interaction } from 'discord.js';
import type { IncomingMessage } from '../src/platforms/types.js';

const { registerDefaultBadWords } = await import('../src/moderation/wordlist.js');
const { hasGuildAdmitter } = await import('../src/platforms/discord/guildAdmission.js');
const { resolveRole } = await import('../src/auth/roles.js');
const { registerCommands, bindDiscordCommand } = await import('../src/commands/registry.js');
const { handleInteraction, registerGuildCommands } =
  await import('../src/platforms/discord/slashDispatch.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { registerTestNoticePack } = await import('./fixtures/noticePack.js');
type AdapterTextPack = import('../src/platforms/types.js').AdapterTextPack;

registerDefaultBadWords(['guild-admission-default-term']);
registerTestNoticePack();
registerCommands([{ name: 'claim', platforms: ['discord'], preAdmission: true }]);
const dispatched: string[] = [];
bindDiscordCommand('claim', {
  build: () => ({ name: 'claim', description: 'test' }),
  handle: async (interaction) => {
    dispatched.push(interaction.guildId ?? 'dm');
  },
});

function harness() {
  const adapter = new DiscordAdapter({} as AdapterTextPack);
  const internals = adapter as unknown as {
    onDiscordMessage: (message: unknown) => Promise<void>;
    inArchiveScope: (guildId: string | null, channelId: string) => Promise<boolean>;
    moderator: { scan: (ctx: unknown) => Promise<void> };
  };
  const heard: IncomingMessage[] = [];
  const scanned: unknown[] = [];
  adapter.onMessage(async (msg) => {
    heard.push(msg);
  });
  internals.moderator = {
    scan: async (ctx) => {
      scanned.push(ctx);
    },
  };
  return { heard, scanned, internals };
}

function guildMessage(guildId: string, channelId: string) {
  return {
    id: `${guildId}-msg`,
    author: { id: 'author-1', bot: false, username: 'author' },
    member: { displayName: 'Author' },
    channel: { type: ChannelType.GuildText, isThread: () => false },
    guildId,
    channelId,
    content: 'hello',
    attachments: { size: 0, first: () => undefined },
    mentions: { users: { has: () => false } },
    reference: null,
    webhookId: null,
    createdTimestamp: 1,
  };
}

test('no module registered admitGuild', () => {
  assert.equal(hasGuildAdmitter(), false);
});

test('SECURITY: with no hook, a second guild is dropped exactly as before — no handler, no moderation scan — and home is heard', async () => {
  const { heard, scanned, internals } = harness();
  await internals.onDiscordMessage(guildMessage(OTHER, 'other-channel'));
  assert.equal(heard.length, 0);
  assert.equal(scanned.length, 0);
  await internals.onDiscordMessage(guildMessage(HOME, 'home-channel'));
  assert.deepEqual(
    heard.map((m) => m.conversationId),
    ['home-channel'],
  );
  assert.equal(scanned.length, 1);
  assert.equal(await internals.inArchiveScope(OTHER, 'other-channel'), false);
  assert.equal(await internals.inArchiveScope(HOME, 'home-channel'), true);
});

test('SECURITY: with no hook, registration never reaches another guild, and a preAdmission command is not dispatched from one', async () => {
  const sets: string[] = [];
  const client = {
    application: {
      commands: {
        set: async (_commands: unknown, guildId: string) => {
          sets.push(guildId);
        },
      },
    },
  } as unknown as Client;
  assert.equal(await registerGuildCommands(client, OTHER), 'skipped');
  assert.equal(await registerGuildCommands(client, HOME), 'admitted');
  assert.deepEqual(sets, [HOME]);

  const gates = {
    isUserBlockedFn: async () => false,
    isPausedFn: async () => false,
    resolveRoleFn: resolveRole,
  };
  const interaction = (guildId: string) =>
    ({
      isChatInputCommand: () => true,
      commandName: 'claim',
      guildId,
      channelId: 'c',
      user: { id: SUPER },
      reply: async () => {},
    }) as unknown as Interaction;
  await handleInteraction(interaction(OTHER), { filtered: async (t) => t }, gates);
  await handleInteraction(interaction(HOME), { filtered: async (t) => t }, gates);
  assert.deepEqual(dispatched, [HOME]);
});

test('every guild check in the Discord adapter and slash dispatch goes through guildAdmission.ts', () => {
  // A structural floor under "one predicate": a raw comparison against the
  // configured guild id reintroduced anywhere here would bypass admission.
  for (const file of ['src/platforms/discord/adapter.ts', 'src/platforms/discord/slashDispatch.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[!=]==?\s*config\.discord\.guildId/, file);
    assert.doesNotMatch(source, /config\.discord\.guildId\s*[!=]==?/, file);
  }
});
