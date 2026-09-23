import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it.
const hasDb = Boolean(process.env.DATABASE_URL);

const SUPER = '9204000000000000001';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.SUPER_ADMIN_DISCORD_IDS = SUPER;

const dbSkip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { registerDefaultBadWords } = await import('../src/moderation/wordlist.js');
const { config } = await import('../src/config.js');
const { upsertMember, addWarning } = await import('../src/storage/repository.js');
const { registerAuthorityResolver, resolveRole, isModerationExempt } = await import('../src/auth/roles.js');
const { createModerator } = await import('../src/moderation/index.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { planComposition } = await import('../src/createAgent.js');
type Tier = import('../src/auth/tiers.js').Tier;
type AdapterTextPack = import('../src/platforms/types.js').AdapterTextPack;
type ModerationEnforcer = import('../src/moderation/index.js').ModerationEnforcer;

// The adapter builds its Moderator at construction, which needs a wordlist.
registerDefaultBadWords(['authres-test-term']);

/**
 * WattoBot #204: a seat in `community_users` is deployment-wide, so a person
 * invited as `admin` by ANY organisation used to read as admin on every base
 * path. The module's `resolveAuthority` override narrows it; these tests drive
 * each base path that reads standing with an override that says "this admin
 * seat is only a member here". The no-override half lives in
 * authorityResolverDefault.test.ts, because the registry is once per process.
 */
const RUN = `authres-${process.pid}-${Date.now()}`;
const NARROWED_ADMIN = `${RUN}-narrowed-admin`;
const TRUSTED_ADMIN = `${RUN}-trusted-admin`;
const WIDENED_GUEST = `${RUN}-widened-guest`;

/** What the override answers, per user id. Unlisted users keep their seat. */
const overrides = new Map<string, unknown>([
  [SUPER, 'member'],
  [NARROWED_ADMIN, 'member'],
  [WIDENED_GUEST, 'super_admin'],
]);
const seen: Array<{ userId: string; seat: Tier }> = [];
registerAuthorityResolver(({ userId, seat }) => {
  seen.push({ userId, seat });
  return (overrides.has(userId) ? overrides.get(userId) : seat) as Tier;
});

const enforcer: ModerationEnforcer = {
  muteUser: async () => {},
  warnInChannel: async () => {},
  warnUser: async () => {},
  unmuteUser: async () => {},
  postAdminAlert: async () => {},
};

/** The isExempt the production Moderator was actually built with. */
function wiredIsExempt(): (platform: 'discord', userId: string) => Promise<boolean> {
  const moderator = createModerator(enforcer) as unknown as {
    deps: { isExempt: (platform: 'discord', userId: string) => Promise<boolean> };
  };
  return moderator.deps.isExempt;
}

/** Run the real rejoin path with the Discord side stubbed; report whether it re-muted. */
async function rejoin(userId: string): Promise<boolean> {
  const adapter = new DiscordAdapter({} as AdapterTextPack) as unknown as {
    muteUser: (id: string) => Promise<void>;
    postAdminAlert: (text: string) => Promise<void>;
    remuteOnRejoinIfNeeded: (member: {
      id: string;
      displayName: string;
      guild: { id: string };
    }) => Promise<void>;
  };
  let muted = false;
  adapter.muteUser = async () => {
    muted = true;
  };
  adapter.postAdminAlert = async () => {};
  await adapter.remuteOnRejoinIfNeeded({
    id: userId,
    displayName: userId,
    guild: { id: config.discord.guildId },
  });
  return muted;
}

async function strikeOut(userId: string): Promise<void> {
  for (let i = 0; i < config.moderation.strikeLimit; i++) {
    await addWarning({
      platform: 'discord',
      userId,
      reason: 'test',
      excerpt: null,
      source: 'admin',
      issuedBy: RUN,
    });
  }
}

test('SECURITY: the override narrows an env super admin, and moderation stops exempting them', async () => {
  assert.equal(await resolveRole('discord', SUPER), 'member');
  assert.equal(await isModerationExempt('discord', SUPER), false);
  assert.equal(await wiredIsExempt()('discord', SUPER), false, 'the Moderator createModerator builds agrees');
  assert.deepEqual(
    seen.find((s) => s.userId === SUPER),
    { userId: SUPER, seat: 'super_admin' },
    'the override is handed the seat the base resolved',
  );
});

test('SECURITY: an override answer that is not a tier resolves to guest', async () => {
  overrides.set(SUPER, 'owner');
  try {
    assert.equal(await resolveRole('discord', SUPER), 'guest');
  } finally {
    overrides.set(SUPER, 'member');
  }
});

test(
  'SECURITY: an admin seat narrowed to member is not exempt from moderation',
  { skip: dbSkip },
  async () => {
    await upsertMember({ platform: 'discord', userId: NARROWED_ADMIN, role: 'admin', addedBy: RUN });
    assert.equal(await resolveRole('discord', NARROWED_ADMIN), 'member');
    assert.equal(await isModerationExempt('discord', NARROWED_ADMIN), false);
    assert.equal(await wiredIsExempt()('discord', NARROWED_ADMIN), false);
  },
);

test(
  'SECURITY: an admin seat narrowed to member is re-muted on rejoin; the skip does not fire',
  { skip: dbSkip },
  async () => {
    await upsertMember({ platform: 'discord', userId: NARROWED_ADMIN, role: 'admin', addedBy: RUN });
    await strikeOut(NARROWED_ADMIN);
    assert.equal(await rejoin(NARROWED_ADMIN), true);
  },
);

test(
  'an admin seat the override leaves alone is still exempt, and the rejoin skip still fires',
  { skip: dbSkip },
  async () => {
    await upsertMember({ platform: 'discord', userId: TRUSTED_ADMIN, role: 'admin', addedBy: RUN });
    await strikeOut(TRUSTED_ADMIN);
    assert.equal(await resolveRole('discord', TRUSTED_ADMIN), 'admin');
    assert.equal(await isModerationExempt('discord', TRUSTED_ADMIN), true);
    assert.equal(await rejoin(TRUSTED_ADMIN), false, 'the exempt admin is not re-muted');
  },
);

test('SECURITY: the override cannot widen a seat', { skip: dbSkip }, async () => {
  // No community_users row: the seat is guest, and the override's super_admin is clamped back.
  assert.equal(await resolveRole('discord', WIDENED_GUEST), 'guest');
  await upsertMember({ platform: 'discord', userId: WIDENED_GUEST, role: 'member', addedBy: RUN });
  assert.equal(await resolveRole('discord', WIDENED_GUEST), 'member');
  assert.equal(await isModerationExempt('discord', WIDENED_GUEST), false);
});

test('the authority resolver is a once-per-process registration', () => {
  assert.throws(() => registerAuthorityResolver(({ seat }) => seat), /already registered/);
});

test('two modules both supplying resolveAuthority is a composition error', () => {
  const resolveAuthority = ({ seat }: { seat: Tier }) => seat;
  assert.throws(
    () =>
      planComposition([
        { name: 'a', resolveAuthority },
        { name: 'b', resolveAuthority },
      ]),
    /both supply the authority resolver/,
  );
});

after(async () => {
  if (hasDb) {
    const ids = [NARROWED_ADMIN, TRUSTED_ADMIN, WIDENED_GUEST];
    await pool.query(`DELETE FROM member_warnings WHERE platform = 'discord' AND user_id = ANY($1)`, [ids]);
    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [ids],
    );
  }
  await closeDb();
});
