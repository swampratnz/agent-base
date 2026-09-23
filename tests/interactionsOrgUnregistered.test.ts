import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const dbSkip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { recordInteraction } = await import('../src/storage/repository/interactions.js');

/**
 * With no `resolveInteractionOrg` registered (its own file: the registry is
 * once per process), a row written as before 0.8.2 gets a NULL org_id, and an
 * explicit `orgId` is still honoured.
 */
const RUN = `intorg0-${process.pid}-${Date.now()}`;

test(
  'with no resolver, a row without orgId is NULL and an explicit orgId is recorded',
  { skip: dbSkip },
  async () => {
    const base = {
      platform: 'discord' as const,
      conversationId: RUN,
      userId: `${RUN}-user`,
      role: 'member' as const,
      direction: 'inbound' as const,
    };
    await recordInteraction({ ...base, content: `${RUN} plain` });
    await recordInteraction({ ...base, content: `${RUN} tagged`, orgId: `${RUN}-org` });
    const { rows } = await pool.query(
      `SELECT content, org_id FROM interactions WHERE conversation_id = $1 ORDER BY content`,
      [RUN],
    );
    assert.deepEqual(rows, [
      { content: `${RUN} plain`, org_id: null },
      { content: `${RUN} tagged`, org_id: `${RUN}-org` },
    ]);
  },
);

after(async () => {
  if (hasDb) await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [RUN]);
  await closeDb();
});
