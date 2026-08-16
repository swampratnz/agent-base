import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// findKnowledgeCoveringTopic decides whether a proposed topic is "already
// covered" by an existing knowledge entry — and therefore whether a member's
// suggest_knowledge tip, or a builder-drafted candidate, is REFUSED. It used to
// reuse the #95 retrieval floor (0.35), which answers a different question
// ("is this worth showing to someone who asked?") and is far too eager as a
// redundancy test.
//
// The value that replaces it is a judgement call, so what this file pins is not
// a number but the PLUMBING: that the knob is genuinely consulted, in both
// directions, rather than a constant having been swapped for a differently
// hardcoded constant. A calibrated default needs a corpus of real near-misses,
// which is what the debug log line in findKnowledgeCoveringTopic exists to
// collect; asserting a specific similarity here would be inventing that data.
//
// This file owns its own process (node:test runs files in separate processes),
// so setting the threshold env var here cannot leak into any other suite.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// Unreachable by construction: cosine similarity is <= 1, and the check is
// `>=`, so only a numerically exact 1.0 could pass. Any topic being reported as
// covered under this setting would mean the threshold is not being read at all.
process.env.KNOWLEDGE_COVERAGE_SIMILARITY_THRESHOLD = '1';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { embed } = await import('../src/storage/embeddings.js');
const { saveKnowledge, knowledgeCoversTopic, findKnowledgeCoveringTopic } =
  await import('../src/storage/repository.js');

after(async () => {
  await closeDb();
});

test('the coverage threshold is read from config, not hardcoded to the retrieval floor', () => {
  assert.equal(
    config.contextCandidates.coverageSimilarityThreshold,
    1,
    'the env var must reach config — otherwise the DB assertions below prove nothing',
  );
});

test(
  'a topic an entry obviously covers is NOT flagged as covered when the threshold is unreachable — proving the knob gates the decision',
  { skip },
  async () => {
    // Deliberately RUN-free invented words: findKnowledgeCoveringTopic scans
    // ALL knowledge unscoped by design, so in a full-suite run other files'
    // fixture rows are present too, and sharing the numeric ${RUN} tag between
    // a fixture and a query is itself a lexical overlap the embedding model
    // can read as similarity. Same convention as repository.test.ts.
    const { id } = await saveKnowledge({
      title: 'Vorpalquint deployment',
      content: 'Vorpalquint deployment: run the migrate step, then restart the vorpalquint service.',
      scope: 'global',
    });
    try {
      // At the OLD hardcoded 0.35 this near-identical phrasing was covered —
      // that is precisely the behaviour this change narrows.
      const vec = await embed('vorpalquint deployment steps');
      assert.equal(
        await knowledgeCoversTopic(vec),
        false,
        'an unreachable threshold must refuse to call anything covered',
      );
      assert.equal(
        await findKnowledgeCoveringTopic(vec),
        null,
        'and the entry-returning form must agree with the boolean wrapper',
      );
    } finally {
      await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
    }
  },
);

test('a null vector still fails open to "not covered", whatever the threshold', { skip }, async () => {
  // The fail-open posture is deliberate and unchanged: a transient embedding
  // outage may only ever produce an EXTRA candidate for an admin to decline,
  // never silently suppress a genuinely new contribution.
  assert.equal(await knowledgeCoversTopic(null), false);
  assert.equal(await findKnowledgeCoveringTopic(null), null);
});
