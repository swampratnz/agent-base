import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Why this file exists.
//
// 0.7.0 shipped super-admin tool arming, and it did nothing. `arm shell`
// recorded the window, the acknowledgement came back, `buildQueryOptions`
// computed the full built-in surface — and the model still said it had no
// shell. Nothing was mis-wired: every argument was threaded, and every gate
// reported success. The turn after the arming RESUMED the session that the
// UNARMED message had started seconds earlier, and a resumed Agent SDK
// session keeps the configuration it was started with (proved for the system
// prompt in 0.6.6). Arming changed no prompt bytes, so `resumableSessionId`
// resumed, and the armed tool list never reached the model.
//
// The fix makes arming visible to the fingerprint: an armed turn renders a
// prompt slot, which changes the bytes, which forces a fresh session that
// carries the new tool surface. These are the pins whose ABSENCE let a
// switched-off feature pass its own release — so they assert the end-to-end
// consequence (a session cannot be resumed across an arming), not just that
// a flag is readable.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { buildSystemPrompt, PROMPT_SLOT_ORDER } = await import('../src/agent/systemPrompt.js');
const { registerPromptSections } = await import('../src/agent/promptSpine.js');
const { promptPolicyFor, systemPromptFingerprint, resumableSessionId } = await import('../src/agent/core.js');
const { armMutatingTools, disarmMutatingTools, resetArmingsForTest } =
  await import('../src/agent/builtinTools.js');

// A valid section registration is once-per-process (systemPrompt.test.ts
// names that rule while driving only INVALID inputs). This file is the
// assembler's own process, so it registers a minimal honest pack: the subject
// here is slot rendering, not injection resistance, which promptSpine's own
// suite already covers with a deliberately hostile pack.
registerPromptSections({
  charter: 'CHARTER',
  behaviourGuidelines: '- be useful',
  recallEtiquette: '- cite recalled context',
  conductGuidance: '- be kind',
  promptReviewClause: '- review prompts',
  webSearchAuthority: 'prefer primary sources',
  dateLine: () => 'Today is 2026-09-12.',
  responseStyleSections: {},
  languagePreferenceSections: {},
});

const PERSONA = { id: 't', name: 'T', aliases: ['t'], voice: 'Speak plainly.' };
const FIXED_NOW = new Date('2026-09-12T06:26:46Z');
const ACTOR = 'sa-1';

const caller = {
  platform: 'whatsapp' as const,
  userId: ACTOR,
  userName: 'Owner',
  role: 'super_admin' as const,
  conversationId: 'c1',
  isDirect: true,
};

const BASE_POLICY = { codeAnswers: 'full' as const, responseStyle: 'standard', languagePreference: 'auto' };

const promptWith = (shellArmed?: boolean): string =>
  buildSystemPrompt(
    caller,
    { ...BASE_POLICY, ...(shellArmed === undefined ? {} : { shellArmed }) },
    PERSONA,
    FIXED_NOW,
  );

beforeEach(() => resetArmingsForTest());

test('promptPolicyFor reads the arming for THIS actor, conversation and platform — the check the production path was never pinned to make', () => {
  // The 0.7.0 bug in one assertion: nothing proved the turn assembly consulted
  // isMutatingArmed at all. A flag with a safe default and no behaviour test
  // is how a feature ships switched off while reporting success.
  assert.equal(promptPolicyFor(caller, 'full', 'standard', 'auto').shellArmed, false);
  armMutatingTools('whatsapp', 'c1', ACTOR);
  assert.equal(promptPolicyFor(caller, 'full', 'standard', 'auto').shellArmed, true);
  // Scoped exactly as the router's arm-shell step wrote it.
  assert.equal(promptPolicyFor({ ...caller, userId: 'sa-2' }, 'full', 'standard', 'auto').shellArmed, false);
  assert.equal(
    promptPolicyFor({ ...caller, conversationId: 'c2' }, 'full', 'standard', 'auto').shellArmed,
    false,
  );
  assert.equal(
    promptPolicyFor({ ...caller, platform: 'discord' }, 'full', 'standard', 'auto').shellArmed,
    false,
  );
});

test('SECURITY: an armed turn cannot resume the session an unarmed turn started — the prompt fingerprint must change', () => {
  // The end-to-end pin. This is the behaviour that was broken live: turn 1
  // (unarmed) started a session, turn 2 (armed) resumed it, so the armed tool
  // list never applied. Asserted through resumableSessionId itself rather than
  // through hash inequality alone, because the decision is what matters.
  const unarmedHash = systemPromptFingerprint(promptWith(false));
  const armedHash = systemPromptFingerprint(promptWith(true));
  assert.notEqual(armedHash, unarmedHash, 'arming must change the prompt bytes');

  const startedUnarmed = {
    sessionId: 'sess-unarmed',
    promptHash: unarmedHash,
    turnCount: 1,
    updatedAt: FIXED_NOW,
  };
  assert.deepEqual(resumableSessionId(startedUnarmed, armedHash, FIXED_NOW.getTime() + 1_000), {
    sessionId: null,
    reason: 'prompt-changed',
  });
  // And the converse: disarming must not silently keep the armed session
  // either, or the tools would outlive the window inside one conversation.
  const startedArmed = { ...startedUnarmed, sessionId: 'sess-armed', promptHash: armedHash };
  assert.deepEqual(resumableSessionId(startedArmed, unarmedHash, FIXED_NOW.getTime() + 1_000), {
    sessionId: null,
    reason: 'prompt-changed',
  });
  // A turn INSIDE the window still resumes normally — the note is fixed text,
  // so consecutive armed turns are byte-identical.
  assert.deepEqual(resumableSessionId(startedArmed, armedHash, FIXED_NOW.getTime() + 1_000), {
    sessionId: 'sess-armed',
    reason: 'resumable',
  });
});

test('SECURITY: an UNARMED turn renders byte-identically to a turn with no arming concept at all', () => {
  // Keeps this change off every existing conversation: unarmed bytes are
  // unchanged from before the slot existed, so stored fingerprints stay valid
  // and no chat is restarted by the upgrade. The slot renders null and is
  // filtered out before the join.
  assert.equal(
    promptWith(false),
    promptWith(undefined),
    'shellArmed:false must equal the field being absent',
  );
  assert.doesNotMatch(promptWith(false), /ARMED/, 'no arming text may leak into an unarmed prompt');
  assert.doesNotMatch(promptWith(false), /Bash, Write, Edit/);
});

test('the armed note renders in its frozen slot position, between the role note and the code policy', () => {
  const prompt = promptWith(true);
  assert.match(prompt, /Shell tools: ARMED for this conversation by a super admin\./);
  assert.match(prompt, /Bash, Write, Edit and NotebookEdit are available to you and pre-approved/);
  // Position, not just presence: the arming statement must sit with the RBAC
  // framing and above the policy blocks, where the model reads it as an
  // authorisation fact rather than late flavour.
  const roleNoteAt = prompt.indexOf('The current requester is a SUPER ADMIN');
  const armedAt = prompt.indexOf('Shell tools: ARMED');
  const codePolicyAt = prompt.indexOf('Code policy:');
  assert.ok(roleNoteAt > -1 && armedAt > -1 && codePolicyAt > -1, 'all three blocks must be present');
  assert.ok(roleNoteAt < armedAt, 'the armed note follows the role note');
  assert.ok(armedAt < codePolicyAt, 'and precedes the code policy');
  assert.deepEqual(
    [...PROMPT_SLOT_ORDER].slice(5, 8),
    ['role-note', 'shell-arming', 'code-policy'],
    'the frozen slot order must place shell-arming between them',
  );
});

test('SECURITY: the armed note carries no countdown — a byte-varying note would restart the session every turn', () => {
  // Not cosmetic. The note is the fingerprint input, so any per-turn variance
  // (seconds remaining, an expiry timestamp) would make every message inside
  // the window refuse to resume and start fresh, discarding the conversation
  // the window exists to serve. The duration is told to the HUMAN in the
  // router's acknowledgement instead.
  const armed = promptWith(true);
  const noteAt = armed.indexOf('Shell tools: ARMED');
  const note = armed.slice(noteAt, armed.indexOf('\n\n', noteAt));
  assert.doesNotMatch(note, /\d/, `the armed note must contain no digits: ${note}`);
  // Built twice at different clock times, the armed prompt is identical.
  const later = buildSystemPrompt(
    caller,
    { ...BASE_POLICY, shellArmed: true },
    PERSONA,
    new Date(FIXED_NOW.getTime() + 240_000),
  );
  assert.equal(systemPromptFingerprint(armed), systemPromptFingerprint(later));
});

test('SECURITY: a disarm returns the prompt to its unarmed bytes, so the armed framing cannot outlive the window', () => {
  armMutatingTools('whatsapp', 'c1', ACTOR);
  const armedPolicy = promptPolicyFor(caller, 'full', 'standard', 'auto');
  assert.equal(armedPolicy.shellArmed, true);
  disarmMutatingTools('whatsapp', 'c1', ACTOR);
  const afterPolicy = promptPolicyFor(caller, 'full', 'standard', 'auto');
  assert.equal(afterPolicy.shellArmed, false);
  assert.equal(
    buildSystemPrompt(caller, afterPolicy, PERSONA, FIXED_NOW),
    promptWith(false),
    'a disarmed turn must be byte-identical to a never-armed one',
  );
});
