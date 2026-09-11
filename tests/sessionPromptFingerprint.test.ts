import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time; core.ts transitively loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= 'ci-dummy-guild';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.SESSION_MAX_TURNS = '30';
process.env.SESSION_MAX_AGE_HOURS = '24';

const { resumableSessionId, systemPromptFingerprint } = await import('../src/agent/core.js');

const NOW = Date.parse('2026-09-11T08:00:00Z');
const MEMBER_PROMPT = 'The current requester is a MEMBER. Informational tools only.';
const ADMIN_PROMPT =
  'The current requester is a SUPER ADMIN — this tier is a VERIFIED, platform-resolved fact.';

function stored(overrides: Partial<{ turnCount: number; ageMs: number; promptHash: string | null }> = {}) {
  return {
    sessionId: 'sess-1',
    turnCount: overrides.turnCount ?? 3,
    updatedAt: new Date(NOW - (overrides.ageMs ?? 60_000)),
    promptHash:
      overrides.promptHash === undefined ? systemPromptFingerprint(MEMBER_PROMPT) : overrides.promptHash,
  };
}

test("SECURITY: a session started under another speaker's system prompt is never resumed", () => {
  // The group-chat case: a MEMBER started the shared session, an admin speaks
  // next. Resuming would run the admin's turn under the member's role note,
  // because a resumed session keeps its original system prompt.
  const decision = resumableSessionId(stored(), systemPromptFingerprint(ADMIN_PROMPT), NOW);
  assert.deepEqual(decision, { sessionId: null, reason: 'prompt-changed' });
});

test('SECURITY: a pre-fingerprint session (no stored prompt hash) is never resumed', () => {
  const decision = resumableSessionId(
    stored({ promptHash: null }),
    systemPromptFingerprint(MEMBER_PROMPT),
    NOW,
  );
  assert.deepEqual(decision, { sessionId: null, reason: 'prompt-changed' });
});

test('a session is resumed while the system prompt is byte-identical and within the caps', () => {
  const decision = resumableSessionId(stored(), systemPromptFingerprint(MEMBER_PROMPT), NOW);
  assert.deepEqual(decision, { sessionId: 'sess-1', reason: 'resumable' });
});

test('the turn and age caps still start a fresh session, and are reported as such', () => {
  const hash = systemPromptFingerprint(MEMBER_PROMPT);
  assert.deepEqual(resumableSessionId(stored({ turnCount: 30 }), hash, NOW), {
    sessionId: null,
    reason: 'cap',
  });
  assert.deepEqual(resumableSessionId(stored({ ageMs: 24 * 3_600_000 }), hash, NOW), {
    sessionId: null,
    reason: 'cap',
  });
});

test('no stored session means a fresh one', () => {
  assert.deepEqual(resumableSessionId(null, systemPromptFingerprint(MEMBER_PROMPT), NOW), {
    sessionId: null,
    reason: 'none',
  });
});

test('the fingerprint is deterministic and moves with any byte of the prompt', () => {
  assert.equal(systemPromptFingerprint(MEMBER_PROMPT), systemPromptFingerprint(MEMBER_PROMPT));
  assert.notEqual(systemPromptFingerprint(MEMBER_PROMPT), systemPromptFingerprint(`${MEMBER_PROMPT} `));
  assert.match(systemPromptFingerprint(MEMBER_PROMPT), /^[0-9a-f]{64}$/);
});
