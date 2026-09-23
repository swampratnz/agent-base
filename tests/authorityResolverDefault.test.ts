import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const hasDb = Boolean(process.env.DATABASE_URL);

const SUPER = '9204000000000000002';
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
const { resolveRole, isModerationExempt } = await import('../src/auth/roles.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
type AdapterTextPack = import('../src/platforms/types.js').AdapterTextPack;

// The adapter builds its Moderator at construction, which needs a wordlist.
registerDefaultBadWords(['authres-test-term']);

/**
 * The other half of authorityResolver.test.ts: with NO `resolveAuthority`
 * registered (its own file, because the registry is once per process), every
 * path reads the raw deployment seat exactly as 0.8.1 did.
 */
const RUN = `authdef-${process.pid}-${Date.now()}`;
const ADMIN = `${RUN}-admin`;
const MEMBER = `${RUN}-member`;

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

test('with no override, an env super admin resolves to super_admin and is exempt', async () => {
  assert.equal(await resolveRole('discord', SUPER), 'super_admin');
  assert.equal(await isModerationExempt('discord', SUPER), true);
});

test(
  'with no override, a stored admin seat is admin, exempt, and skipped on rejoin',
  { skip: dbSkip },
  async () => {
    await upsertMember({ platform: 'discord', userId: ADMIN, role: 'admin', addedBy: RUN });
    await strikeOut(ADMIN);
    assert.equal(await resolveRole('discord', ADMIN), 'admin');
    assert.equal(await isModerationExempt('discord', ADMIN), true);
    assert.equal(await rejoin(ADMIN), false);
  },
);

test(
  'with no override, a struck-out member is re-muted on rejoin and an unknown user is a guest',
  { skip: dbSkip },
  async () => {
    await upsertMember({ platform: 'discord', userId: MEMBER, role: 'member', addedBy: RUN });
    await strikeOut(MEMBER);
    assert.equal(await resolveRole('discord', MEMBER), 'member');
    assert.equal(await isModerationExempt('discord', MEMBER), false);
    assert.equal(await rejoin(MEMBER), true);
    assert.equal(await resolveRole('discord', `${RUN}-nobody`), 'guest');
  },
);

after(async () => {
  if (hasDb) {
    const ids = [ADMIN, MEMBER];
    await pool.query(`DELETE FROM member_warnings WHERE platform = 'discord' AND user_id = ANY($1)`, [ids]);
    await pool.query(
      `DELETE FROM community_users WHERE platform = 'discord' AND platform_user_id = ANY($1)`,
      [ids],
    );
  }
  await closeDb();
});
