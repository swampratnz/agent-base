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
const { recordInteraction, registerInteractionOrgResolver, orgSpend } =
  await import('../src/storage/repository/interactions.js');
const { planComposition } = await import('../src/createAgent.js');
type InteractionInput = import('../src/storage/repository/interactions.js').InteractionInput;

/**
 * WattoBot #201: `interactions` gained a nullable `org_id`, so a per-tenant
 * money read is a predicate on the ledger itself and a test file can scope the
 * rows it wrote. The no-resolver half is interactionsOrgUnregistered.test.ts,
 * because the resolver registry is once per process.
 */
const RUN = `intorg-${process.pid}-${Date.now()}`;
const ORG_A = `${RUN}-org-a`;
const ORG_B = `${RUN}-org-b`;
const CONVO = `${RUN}-convo`;
const SPEND_A = `${RUN}-spend-a`;
const SPEND_B = `${RUN}-spend-b`;

// The resolver answers from meta so each test chooses what it says; a
// `throw` key makes it fail.
registerInteractionOrgResolver((input) => {
  if (input.meta?.throw) throw new Error('resolver down');
  return input.meta?.resolverOrg as string | undefined;
});

function row(over: Partial<InteractionInput>): InteractionInput {
  return {
    platform: 'discord',
    conversationId: CONVO,
    userId: `${RUN}-user`,
    role: 'member',
    direction: 'outbound',
    content: `${RUN} row`,
    ...over,
  };
}

async function orgOf(content: string): Promise<string | null> {
  const { rows } = await pool.query<{ org_id: string | null }>(
    `SELECT org_id FROM interactions WHERE conversation_id = $1 AND content = $2`,
    [CONVO, content],
  );
  assert.equal(rows.length, 1, `exactly one row for ${content}`);
  return rows[0].org_id;
}

test('the migration adds a nullable text org_id and its partial index', { skip: dbSkip }, async () => {
  const { rows } = await pool.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'interactions' AND column_name = 'org_id'`,
  );
  assert.deepEqual(rows, [{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  const idx = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'interactions_org_idx'`,
  );
  assert.match(idx.rows[0]?.indexdef ?? '', /\(org_id, created_at DESC\) WHERE \(org_id IS NOT NULL\)/);
});

test('an explicit orgId is recorded and wins over the resolver', { skip: dbSkip }, async () => {
  await recordInteraction(row({ content: `${RUN} explicit`, orgId: ORG_A, meta: { resolverOrg: ORG_B } }));
  assert.equal(await orgOf(`${RUN} explicit`), ORG_A);
});

test('an explicit null is recorded unattributed without asking the resolver', { skip: dbSkip }, async () => {
  await recordInteraction(row({ content: `${RUN} null`, orgId: null, meta: { resolverOrg: ORG_B } }));
  assert.equal(await orgOf(`${RUN} null`), null);
});

test('with no orgId, the resolver attributes the row (the router path)', { skip: dbSkip }, async () => {
  await recordInteraction(row({ content: `${RUN} resolved`, meta: { resolverOrg: ORG_B } }));
  assert.equal(await orgOf(`${RUN} resolved`), ORG_B);
  await recordInteraction(row({ content: `${RUN} unresolved` }));
  assert.equal(await orgOf(`${RUN} unresolved`), null, 'a resolver answering nothing leaves NULL');
});

test('a throwing resolver still records the row, unattributed', { skip: dbSkip }, async () => {
  await recordInteraction(row({ content: `${RUN} thrown`, meta: { throw: true } }));
  assert.equal(await orgOf(`${RUN} thrown`), null);
});

test(
  'SECURITY: orgSpend sums one organisation only, outbound only, inside the window',
  { skip: dbSkip },
  async () => {
    // Its own organisations: the rows the tests above wrote are ORG_A/ORG_B, now.
    const insert = (org: string | null, direction: string, cost: number, at: string) =>
      pool.query(
        `INSERT INTO interactions (platform, conversation_id, user_id, role, direction, content, cost_usd, created_at, org_id)
       VALUES ('discord', $1, $2, 'member', $3, $4, $5, $6, $7)`,
        [CONVO, `${RUN}-spend`, direction, `${RUN} spend`, cost, at, org],
      );
    await insert(SPEND_A, 'outbound', 1.25, '2026-01-10T00:00:00Z');
    await insert(SPEND_A, 'outbound', 0.75, '2026-01-12T00:00:00Z');
    await insert(SPEND_A, 'inbound', 9, '2026-01-11T00:00:00Z'); // not spend
    await insert(SPEND_A, 'outbound', 5, '2026-01-20T00:00:00Z'); // after the window
    await insert(SPEND_A, 'outbound', 7, '2026-01-01T00:00:00Z'); // before it
    await insert(SPEND_B, 'outbound', 100, '2026-01-11T00:00:00Z'); // another tenant
    await insert(null, 'outbound', 1000, '2026-01-11T00:00:00Z'); // unattributed

    const window = { from: new Date('2026-01-05T00:00:00Z'), to: new Date('2026-01-20T00:00:00Z') };
    assert.deepEqual(await orgSpend(SPEND_A, window), { costUsd: 2, replies: 2 }, '[from, to) excludes `to`');
    assert.deepEqual(await orgSpend(SPEND_B, window), { costUsd: 100, replies: 1 });
    assert.deepEqual(await orgSpend(SPEND_A, { from: new Date('2026-01-05T00:00:00Z') }), {
      costUsd: 7,
      replies: 3,
    });
    assert.deepEqual(await orgSpend(`${RUN}-org-none`, window), { costUsd: 0, replies: 0 });
  },
);

test('SECURITY: orgSpend refuses an empty organisation rather than answering for the deployment', async () => {
  await assert.rejects(orgSpend('', { from: new Date(0) }), /organisation id is required/);
});

test('the interaction organisation resolver is once per process, and one module may supply it', () => {
  assert.throws(() => registerInteractionOrgResolver(() => null), /already registered/);
  const resolveInteractionOrg = () => null;
  assert.throws(
    () =>
      planComposition([
        { name: 'a', resolveInteractionOrg },
        { name: 'b', resolveInteractionOrg },
      ]),
    /both supply the interaction organisation resolver/,
  );
});

after(async () => {
  if (hasDb) await pool.query(`DELETE FROM interactions WHERE conversation_id = $1`, [CONVO]);
  await closeDb();
});
