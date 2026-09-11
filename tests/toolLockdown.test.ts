import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// Pins for docs/SECURITY.md §2 invariant 1 — the per-turn built-in tool
// lockdown — against `buildQueryOptions` (src/agent/core.ts), which is
// exported for exactly this. Same issue-#9 shape as rbac.test.ts: the
// invariant was enforced in code but pinned by no test in this repository,
// so dropping WebFetch from `disallowedTools` or handing members a built-in
// went green here. The tool set is SYNTHETIC, registered through the real
// APIs exactly as a module's manifest does via createAgent.
const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { buildQueryOptions } = await import('../src/agent/core.js');
const { ALL_BUILTIN_TOOLS, MUTATING_BUILTIN_TOOLS, armMutatingTools, resetArmingsForTest } =
  await import('../src/agent/builtinTools.js');

const TIERS = ['guest', 'member', 'admin', 'super_admin'] as const;

// Registered at module scope, before any test runs, so no test depends on
// another having run first (the `npm run test:security` filter would skip a
// registration written as an ordinary test).
const MEMBER_TOOL = 'mcp__t__ask';
const ADMIN_TOOL = 'mcp__t__moderate';
const SUPER_ADMIN_TOOL = 'mcp__t__purge';
registerToolTiers({
  member: [MEMBER_TOOL],
  admin: [ADMIN_TOOL],
  superAdmin: [SUPER_ADMIN_TOOL],
  discordOnly: [],
});
registerFlaggedToolPredicates([]);

function optionsFor(role: (typeof TIERS)[number]) {
  return buildQueryOptions(role, 'system prompt', {}, null, 'conv-1', 'discord');
}

test('SECURITY: WebFetch and Task are disallowed for EVERY tier by default — URL construction is an exfiltration channel and fetched pages an injection vector', () => {
  // Restored to all four tiers: the full surface is now granted only inside an
  // ARMED window (buildQueryOptions' `fullBuiltins`), and `optionsFor` passes
  // no actor id, so a super-admin turn here is an UNARMED one.
  for (const role of TIERS) {
    const opts = optionsFor(role);
    assert.ok(opts.disallowedTools.includes('WebFetch'), `WebFetch must be disallowed for ${role}`);
    assert.ok(opts.disallowedTools.includes('Task'), `Task must be disallowed for ${role}`);
    assert.ok(!opts.allowedTools.includes('WebFetch'), `WebFetch must never be allowed for ${role}`);
  }
});

test('SECURITY: an UNARMED super-admin turn is granted NO built-in beyond WebSearch — the grant itself is what arming unlocks', () => {
  // The review correction: gating only Bash/Write/Edit/NotebookEdit left
  // Read + WebFetch granted and auto-approved in every super-admin turn, a
  // read-anything-then-send-anywhere pair reachable by injected group text
  // with no arming. The GRANT is now conditional, so an unarmed super admin
  // looks exactly like an admin.
  const opts = optionsFor('super_admin');
  assert.deepEqual(opts.tools, ['WebSearch'], 'an unarmed super admin gets exactly [WebSearch]');
  for (const tool of ALL_BUILTIN_TOOLS.filter((t) => t !== 'WebSearch')) {
    assert.ok(!opts.tools.includes(tool), `${tool} must not be granted while unarmed`);
    assert.ok(!opts.allowedTools.includes(tool), `${tool} must not be pre-approved while unarmed`);
  }
});

test('SECURITY: no tier can be granted a mutating built-in without an arming, and only a super admin can arm', () => {
  // Arming is keyed to the actor, and the grant additionally requires the
  // super_admin tier: an armed actor id on a lower tier grants nothing.
  armMutatingTools('discord', 'conv-1', 'actor-1');
  try {
    for (const role of ['guest', 'member', 'admin'] as const) {
      const opts = buildQueryOptions(role, 'system prompt', {}, null, 'conv-1', 'discord', 'actor-1');
      for (const tool of MUTATING_BUILTIN_TOOLS) {
        assert.ok(!opts.tools.includes(tool), `${tool} must never be granted to ${role}`);
        assert.ok(!opts.allowedTools.includes(tool), `${tool} must never be pre-approved for ${role}`);
      }
      assert.ok(opts.disallowedTools.includes('WebFetch'), `WebFetch stays disallowed for ${role}`);
    }
    const armed = buildQueryOptions('super_admin', 'system prompt', {}, null, 'conv-1', 'discord', 'actor-1');
    for (const tool of ALL_BUILTIN_TOOLS) {
      assert.ok(armed.tools.includes(tool), `${tool} must be granted inside an armed super-admin window`);
    }
    const matchers = (
      armed as { hooks?: { PreToolUse?: Array<{ matcher: string }> } }
    ).hooks?.PreToolUse?.map((entry) => entry.matcher);
    assert.ok(matchers?.includes(MUTATING_BUILTIN_TOOLS.join('|')), 'the arming gate must be attached');
    assert.ok(matchers?.includes('WebSearch'), 'the WebSearch cap must still be attached');
  } finally {
    resetArmingsForTest();
  }
});

test('SECURITY: member and guest turns get NO built-in tools, and WebSearch is explicitly disallowed for them', () => {
  for (const role of ['guest', 'member'] as const) {
    const opts = optionsFor(role);
    assert.deepEqual(opts.tools, [], `built-in tools must be empty for ${role}`);
    assert.ok(opts.disallowedTools.includes('WebSearch'), `WebSearch must be disallowed for ${role}`);
    assert.ok(!opts.allowedTools.includes('WebSearch'), `WebSearch must not be pre-approved for ${role}`);
  }
});

test("SECURITY: a member turn's allowedTools never contains an admin- or super-admin-tier tool", () => {
  const allowed = optionsFor('member').allowedTools;
  assert.ok(allowed.includes(MEMBER_TOOL), 'the member tool itself must be offered');
  assert.ok(!allowed.includes(ADMIN_TOOL), 'an admin tool must never reach a member surface');
  assert.ok(!allowed.includes(SUPER_ADMIN_TOOL), 'a super-admin tool must never reach a member surface');
});

test('SECURITY: admin+ built-ins are WebSearch and ONLY WebSearch (skills off), absent an arming', () => {
  for (const role of ['admin', 'super_admin'] as const) {
    const opts = optionsFor(role);
    assert.deepEqual(opts.tools, ['WebSearch'], `built-ins for ${role} must be exactly [WebSearch]`);
    assert.ok(!opts.disallowedTools.includes('WebSearch'), `WebSearch is granted to ${role}`);
  }
});

test('SECURITY: settingSources is empty for every tier — the host machine’s ~/.claude config is never loaded into a turn', () => {
  for (const role of TIERS) {
    assert.deepEqual(optionsFor(role).settingSources, [], `settingSources must be empty for ${role}`);
  }
});

test('SECURITY: with agent skills disabled (the default), the options carry no plugins/skills keys at all', () => {
  // The never-'all' allowlist rule is enforced at registration
  // (tests/skillsManifest.test.ts); what this pins is the OFF state — no
  // plugin directory and no skills key can reach the SDK when the feature is
  // disabled, for any tier.
  for (const role of TIERS) {
    const opts = optionsFor(role) as Record<string, unknown>;
    assert.ok(!('plugins' in opts), `no plugins key for ${role} with skills disabled`);
    assert.ok(!('skills' in opts), `no skills key for ${role} with skills disabled`);
  }
});
