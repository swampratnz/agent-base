import { test } from 'node:test';
import assert from 'node:assert/strict';

// agent-base #65: a module's `admitGuild` hook lets the Discord adapter hear
// guilds other than DISCORD_GUILD_ID. This file registers a hook (the registry
// is once per process); the no-hook half lives in guildAdmissionDefault.test.ts.
// No database: the adapter's handler, moderator and Discord client are stubbed
// at their seams, and role resolution uses an env super admin, which never
// reads storage.
const HOME = '6500000000000000001';
const ADMITTED = '6500000000000000002';
const STRANGER = '6500000000000000003';
const THROWS = '6500000000000000004';
const TRUTHY = '6500000000000000005';
const HOME_ALLOWED_CHANNEL = '6500000000000000101';
const SUPER = '6500000000000000201';

// Assigned, not `??=`: the assertions need to know exactly which guild is home.
process.env.DISCORD_GUILD_ID = HOME;
process.env.DISCORD_ALLOWED_CHANNEL_IDS = HOME_ALLOWED_CHANNEL;
process.env.DISCORD_SLASH_COMMANDS_ENABLED = 'true';
process.env.SUPER_ADMIN_DISCORD_IDS = SUPER;
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

import { ChannelType, type Client, type Interaction } from 'discord.js';
import type { IncomingMessage } from '../src/platforms/types.js';
import type { SlashDispatchGates } from '../src/platforms/discord/slashDispatch.js';

const { registerDefaultBadWords } = await import('../src/moderation/wordlist.js');
const { registerGuildAdmitter, admitsGuild } = await import('../src/platforms/discord/guildAdmission.js');
const { registerAuthorityResolver, resolveRole } = await import('../src/auth/roles.js');
const { registerCommands, bindDiscordCommand } = await import('../src/commands/registry.js');
const { handleInteraction, registerGuildCommands } =
  await import('../src/platforms/discord/slashDispatch.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { Moderator } = await import('../src/moderation/index.js');
const { Router } = await import('../src/router.js');
const { planComposition } = await import('../src/createAgent.js');
const { registerTestNoticePack } = await import('./fixtures/noticePack.js');
type Tier = import('../src/auth/tiers.js').Tier;
type AdapterTextPack = import('../src/platforms/types.js').AdapterTextPack;
type AuthorityScope = import('../src/auth/roles.js').AuthorityScope;

registerDefaultBadWords(['guild-admission-test-term']);
registerTestNoticePack();

/** Every guild the hook was asked about, in order. */
const asked: string[] = [];
registerGuildAdmitter((guildId) => {
  asked.push(guildId);
  if (guildId === THROWS) throw new Error('claims table unreachable');
  if (guildId === TRUTHY) return 'yes' as unknown as boolean;
  return guildId === ADMITTED;
});

/** Every `who` the authority resolver was handed. It never narrows. */
const seen: Array<{ userId: string; seat: Tier } & AuthorityScope> = [];
registerAuthorityResolver((who) => {
  seen.push({ ...who });
  return who.seat;
});

registerCommands([
  { name: 'ping', platforms: ['discord'] },
  { name: 'claim', platforms: ['discord'], preAdmission: true },
]);
const dispatched: Array<{ name: string; userId: string }> = [];
for (const name of ['ping', 'claim']) {
  bindDiscordCommand(name, {
    build: () => ({ name, description: 'test' }),
    handle: async (interaction, deps) => {
      dispatched.push({ name: interaction.commandName, userId: deps.caller.userId });
    },
  });
}

// ---------------------------------------------------------------- helpers ---

interface Harness {
  heard: IncomingMessage[];
  scanned: unknown[];
  adapter: InstanceType<typeof DiscordAdapter>;
  internals: {
    onDiscordMessage: (message: unknown) => Promise<void>;
    onGuildMemberAdd: (member: unknown) => Promise<void>;
    inArchiveScope: (guildId: string | null, channelId: string) => Promise<boolean>;
    remuteOnRejoinIfNeeded: (member: unknown) => Promise<void>;
    moderator: { scan: (ctx: unknown) => Promise<void> };
  };
}

/** A real DiscordAdapter with the handler and the moderator's scan recorded. */
function harness(): Harness {
  const adapter = new DiscordAdapter({} as AdapterTextPack);
  const internals = adapter as unknown as Harness['internals'];
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
  return { heard, scanned, adapter, internals };
}

/** The slice of a discord.js Message `onDiscordMessage` reads, for a plain text guild message. */
function guildMessage(guildId: string, channelId: string, text = 'hello') {
  return {
    id: `${guildId}-${channelId}-msg`,
    author: { id: 'author-1', bot: false, username: 'author' },
    member: { displayName: 'Author' },
    channel: { type: ChannelType.GuildText, isThread: () => false },
    guildId,
    channelId,
    content: text,
    attachments: { size: 0, first: () => undefined },
    mentions: { users: { has: () => false } },
    reference: null,
    webhookId: null,
    createdTimestamp: 1,
  };
}

function interaction(commandName: string, guildId: string | null, userId = SUPER): Interaction {
  return {
    isChatInputCommand: () => true,
    commandName,
    guildId,
    channelId: 'slash-channel',
    user: { id: userId },
    reply: async () => {},
  } as unknown as Interaction;
}

/** Real role resolution (so the authority resolver runs); the storage-backed gates stubbed. */
const gates: SlashDispatchGates = {
  isUserBlockedFn: async () => false,
  isPausedFn: async () => false,
  resolveRoleFn: resolveRole,
};
const deps = { filtered: async (text: string) => text };

/** A client whose `application.commands.set` records what each guild was given. */
function recordingClient() {
  const sets: Array<{ guildId: string; names: string[] }> = [];
  const client = {
    application: {
      commands: {
        set: async (commands: Array<{ name: string }>, guildId: string) => {
          sets.push({ guildId, names: commands.map((c) => c.name) });
        },
      },
    },
  } as unknown as Client;
  return { client, sets };
}

// --------------------------------------------------------------- messages ---

test('SECURITY: a hook admitting guild B lets B be heard, and guild C is still dropped before anything runs', async () => {
  const { heard, scanned, internals } = harness();
  await internals.onDiscordMessage(guildMessage(ADMITTED, 'b-channel'));
  await internals.onDiscordMessage(guildMessage(STRANGER, 'c-channel'));
  assert.deepEqual(
    heard.map((m) => m.conversationId),
    ['b-channel'],
    'B reaches the handler (and so the router); C never does, so it writes no interactions row',
  );
  assert.equal(heard[0].guildId, ADMITTED, 'the heard message carries its guild for the router');
  assert.equal(scanned.length, 0, 'neither is moderation-scanned: C is dropped, B is not the home guild');
});

test('SECURITY: a throwing hook admits nothing, and neither does a truthy non-true answer', async () => {
  const { heard, scanned, internals } = harness();
  asked.length = 0;
  await internals.onDiscordMessage(guildMessage(THROWS, 't-channel'));
  await internals.onDiscordMessage(guildMessage(TRUTHY, 'y-channel'));
  assert.deepEqual(asked, [THROWS, TRUTHY], 'the hook really was consulted for both');
  assert.equal(heard.length, 0, 'a failed or ambiguous admission is a refusal');
  assert.equal(scanned.length, 0);
  assert.equal(await admitsGuild(THROWS), false);
});

test('the home guild is always admitted without asking the hook, and keeps its allowlist and moderation scan', async () => {
  const { heard, scanned, internals } = harness();
  asked.length = 0;
  await internals.onDiscordMessage(guildMessage(HOME, HOME_ALLOWED_CHANNEL));
  await internals.onDiscordMessage(guildMessage(HOME, 'home-unlisted-channel'));
  assert.deepEqual(asked, [], 'the home hot path never waits on the hook');
  assert.deepEqual(
    heard.map((m) => m.conversationId),
    [HOME_ALLOWED_CHANNEL],
    'the home allowlist still drops an unlisted home channel',
  );
  assert.equal(scanned.length, 1, 'the listed home message is scanned exactly as before');
  assert.equal((scanned[0] as { guildId: string }).guildId, HOME);
});

test('an admitted guild is not bound by the home allowlist, whose ids name home channels only', async () => {
  const { heard, internals } = harness();
  await internals.onDiscordMessage(guildMessage(ADMITTED, 'any-b-channel'));
  assert.equal(heard.length, 1);
});

test('SECURITY: delete and edit honouring covers an admitted guild and still refuses an unadmitted one', async () => {
  const { internals } = harness();
  assert.equal(await internals.inArchiveScope(ADMITTED, 'b-channel'), true);
  assert.equal(await internals.inArchiveScope(STRANGER, 'c-channel'), false);
  assert.equal(await internals.inArchiveScope(THROWS, 't-channel'), false);
  assert.equal(await internals.inArchiveScope(HOME, 'home-unlisted-channel'), false, 'home allowlist kept');
  assert.equal(await internals.inArchiveScope(HOME, HOME_ALLOWED_CHANNEL), true);
});

test('SECURITY: a member joining an admitted guild touches nothing — no roster row, no auto-enroll, no welcome, no re-mute', async () => {
  const { internals } = harness();
  const touched: string[] = [];
  const member = new Proxy(
    { guild: { id: ADMITTED } },
    {
      get(target, prop) {
        if (prop !== 'guild' && typeof prop === 'string') touched.push(prop);
        return Reflect.get(target, prop);
      },
    },
  );
  await internals.onGuildMemberAdd(member);
  assert.deepEqual(touched, [], 'the join handler must return on the guild check alone');
});

// -------------------------------------------------------------- authority ---

test("resolveAuthority sees the guild id on the router's role step", async () => {
  seen.length = 0;
  const ctx = {
    msg: {
      platform: 'discord',
      conversationId: 'b-channel',
      userId: SUPER,
      guildId: ADMITTED,
      isDirect: false,
    } as IncomingMessage,
    state: {} as { role?: Tier },
  };
  const step = (Router.prototype as unknown as { roleResolutionStep: (c: unknown) => Promise<string> })
    .roleResolutionStep;
  assert.equal(await step.call(null, ctx), 'continue');
  assert.deepEqual(seen, [
    {
      platform: 'discord',
      userId: SUPER,
      seat: 'super_admin',
      conversationId: 'b-channel',
      guildId: ADMITTED,
    },
  ]);
});

test('resolveAuthority sees the guild id on moderation exemption and on the rejoin re-mute skip', async () => {
  seen.length = 0;
  const exemptScopes: unknown[] = [];
  const moderator = new Moderator({
    enabled: true,
    strikeLimit: 3,
    alertRateLimitPerHour: 0,
    classify: async () => null,
    isExempt: async (_platform: string, _userId: string, scope?: AuthorityScope) => {
      exemptScopes.push(scope);
      return true;
    },
    getLanguagePreference: async () => null,
    getResponseStyle: async () => null,
    store: { addWarning: async () => {}, countActiveWarnings: async () => 0 },
    enforcer: {
      muteUser: async () => {},
      warnInChannel: async () => {},
      warnUser: async () => {},
      unmuteUser: async () => {},
      postAdminAlert: async () => {},
    },
  } as unknown as ConstructorParameters<typeof Moderator>[0]);
  await moderator.scan({
    platform: 'discord',
    userId: SUPER,
    userName: 's',
    text: 'hi',
    channelId: 'home-channel',
    guildId: HOME,
  });
  assert.deepEqual(exemptScopes, [{ conversationId: 'home-channel', guildId: HOME }]);

  // The rejoin skip: an env super admin whose seat the resolver keeps is exempt,
  // so this returns before any storage read.
  const { internals } = harness();
  await internals.remuteOnRejoinIfNeeded({ id: SUPER, displayName: 's', guild: { id: HOME } });
  assert.deepEqual(seen, [{ platform: 'discord', userId: SUPER, seat: 'super_admin', guildId: HOME }]);
});

// ---------------------------------------------------------- slash commands ---

test('SECURITY: a slash command from an unadmitted guild is not dispatched; a preAdmission one is, with the guild on resolveAuthority', async () => {
  dispatched.length = 0;
  seen.length = 0;
  await handleInteraction(interaction('ping', STRANGER), deps, gates);
  await handleInteraction(interaction('ping', THROWS), deps, gates);
  assert.equal(dispatched.length, 0, 'an ordinary command never runs outside an admitted guild');

  await handleInteraction(interaction('claim', STRANGER), deps, gates);
  await handleInteraction(interaction('ping', ADMITTED), deps, gates);
  assert.deepEqual(
    dispatched.map((d) => d.name),
    ['claim', 'ping'],
    '/claim runs before admission; everything runs once admitted',
  );
  assert.deepEqual(
    seen.map((w) => w.guildId),
    [STRANGER, ADMITTED],
    'the resolver is told which server each dispatch came from',
  );
  assert.equal(seen[0].conversationId, 'slash-channel');
});

test('a DM slash interaction is dispatched exactly as before', async () => {
  dispatched.length = 0;
  await handleInteraction(interaction('ping', null), deps, gates);
  assert.equal(dispatched.length, 1);
});

test('registration: an admitted guild gets every command, any other guild only the preAdmission ones', async () => {
  const { client, sets } = recordingClient();
  assert.equal(await registerGuildCommands(client, ADMITTED), 'admitted');
  assert.equal(await registerGuildCommands(client, STRANGER), 'pre-admission');
  assert.equal(await registerGuildCommands(client, THROWS), 'pre-admission');
  assert.equal(await registerGuildCommands(client, HOME), 'admitted');
  assert.deepEqual(sets, [
    { guildId: ADMITTED, names: ['ping', 'claim'] },
    { guildId: STRANGER, names: ['claim'] },
    { guildId: THROWS, names: ['claim'] },
    { guildId: HOME, names: ['ping', 'claim'] },
  ]);
});

test('registration on boot converges every non-home guild the bot sits in, and skips home (registered as before)', async () => {
  const { adapter } = harness();
  const { client, sets } = recordingClient();
  const guildIds = [HOME, ADMITTED, STRANGER];
  (client as unknown as { guilds: unknown }).guilds = { cache: new Map(guildIds.map((id) => [id, {}])) };
  (adapter as unknown as { client: Client }).client = client;
  await (adapter as unknown as { registerOtherGuilds: () => Promise<void> }).registerOtherGuilds();
  assert.deepEqual(
    sets.map((s) => s.guildId),
    [ADMITTED, STRANGER],
  );
});

// ------------------------------------------------------------ composition ---

test('the guild admitter is a once-per-process registration', () => {
  assert.throws(() => registerGuildAdmitter(() => true), /already registered/);
});

test('two modules both supplying admitGuild is a composition error', () => {
  const admitGuild = () => false;
  assert.throws(
    () =>
      planComposition([
        { name: 'a', admitGuild },
        { name: 'b', admitGuild },
      ]),
    /both supply the guild admitter/,
  );
});
