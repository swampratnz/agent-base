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

test('SECURITY: WebFetch and Task are disallowed for EVERY tier — URL construction is an exfiltration channel and fetched pages an injection vector', () => {
  for (const role of TIERS) {
    const opts = optionsFor(role);
    assert.ok(opts.disallowedTools.includes('WebFetch'), `WebFetch must be disallowed for ${role}`);
    assert.ok(opts.disallowedTools.includes('Task'), `Task must be disallowed for ${role}`);
    assert.ok(!opts.allowedTools.includes('WebFetch'), `WebFetch must never be allowed for ${role}`);
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

test('SECURITY: admin+ built-ins are WebSearch and ONLY WebSearch (skills off)', () => {
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
