import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const rbac = await import('../src/auth/rbac.js');

/**
 * The tier surface — the mechanism that decides which tools a caller is
 * OFFERED, which is the structural half of tool gating (the in-handler
 * re-assertion is the other half, and neither is sufficient alone).
 *
 * This file exists because of issue #9. `rbac.ts` was lifted into this
 * repository without a test file: its 49 `SECURITY:` cases live in
 * community-agent, where they assert that deployment's own tier assignments
 * ("`whats_new` is admin-only") against community tool names. Those are the
 * consumer's assertions and belong there. What was left uncovered HERE is the
 * derivation itself, which is base's, and which a second consumer would
 * inherit with no safety net of its own.
 *
 * So the tool set below is SYNTHETIC — registered through the real
 * `registerToolTiers` API, exactly as a module's manifest does via
 * `createAgent`. That is a better test of the framework contract than the
 * originals were, because it exercises what a module is actually allowed to
 * hand in rather than what one deployment happens to hand in.
 *
 * Registration happens at MODULE SCOPE, before any test runs, so no test here
 * depends on another having run first. That matters because
 * `npm run test:security` executes only the `SECURITY:`-prefixed cases: a
 * registration step written as an ordinary test would be skipped under that
 * filter and take every derived case down with it. The unregistered state is
 * covered by `rbacFailClosed.test.ts`, in its own process.
 */

/** Names shaped like real ones (prefixed, snake_case) but owned by nobody. */
const MEMBER = ['mcp__t__ask', 'mcp__t__search', 'mcp__t__react'] as const;
const ADMIN = ['mcp__t__roster', 'mcp__t__moderate'] as const;
const SUPER_ADMIN = ['mcp__t__purge'] as const;
/** A member tool AND an admin tool, to prove the platform filter is tier-blind. */
const DISCORD_ONLY = ['mcp__t__react', 'mcp__t__moderate'] as const;

// Mutable on purpose: registration must COPY these, not alias them, and the
// test below mutates them afterwards to prove it.
const handedIn = {
  member: [...MEMBER] as string[],
  admin: [...ADMIN] as string[],
  superAdmin: [...SUPER_ADMIN] as string[],
  discordOnly: [...DISCORD_ONLY] as string[],
};
rbac.registerToolTiers(handedIn);

test('SECURITY: registration copies the lists it is handed, and freezes them', () => {
  assert.equal(rbac.areToolTiersRegistered(), true);
  assert.deepEqual(rbac.MEMBER_TOOLS, [...MEMBER]);
  assert.deepEqual(rbac.ADMIN_TOOLS, [...ADMIN]);
  assert.deepEqual(rbac.SUPER_ADMIN_TOOLS, [...SUPER_ADMIN]);

  // Mutating what was handed in does not reach the registered surface — a
  // module that kept a reference to its own arrays cannot widen a tier later.
  handedIn.member.push('mcp__t__smuggled');
  handedIn.admin.length = 0;
  assert.deepEqual(rbac.MEMBER_TOOLS, [...MEMBER], 'the registry must hold a copy');
  assert.deepEqual(rbac.ADMIN_TOOLS, [...ADMIN]);

  // And the copies themselves are frozen, so anything holding a reference to
  // the registered list cannot add a tool to a tier in place either.
  assert.ok(Object.isFrozen(rbac.MEMBER_TOOLS));
  assert.ok(Object.isFrozen(rbac.ADMIN_TOOLS));
  assert.ok(Object.isFrozen(rbac.SUPER_ADMIN_TOOLS));
  assert.throws(() => (rbac.MEMBER_TOOLS as string[]).push('mcp__t__smuggled'));
  assert.deepEqual(rbac.MEMBER_TOOLS, [...MEMBER]);
});

test('the tier lattice orders guest < member < admin < super_admin', () => {
  assert.ok(rbac.atLeast('super_admin', 'admin'));
  assert.ok(rbac.atLeast('admin', 'member'));
  assert.ok(rbac.atLeast('member', 'guest'));
  assert.ok(rbac.atLeast('member', 'member'), 'a tier is at least itself');
  assert.ok(!rbac.atLeast('member', 'admin'));
  assert.ok(!rbac.atLeast('admin', 'super_admin'));
  assert.ok(!rbac.atLeast('guest', 'member'));
});

test('SECURITY: assertAtLeast throws for an insufficient tier, naming the action', () => {
  // The in-handler defence-in-depth check. A privileged tool calls this before
  // any side effect, so that a tool reaching a handler it should never have
  // been offered still refuses.
  assert.throws(
    () => rbac.assertAtLeast('member', 'admin', 'remove_member'),
    /Permission denied: "remove_member" requires admin and caller is "member"/,
  );
  assert.throws(() => rbac.assertAtLeast('admin', 'super_admin', 'purge_user_data'), /requires super_admin/);
  assert.throws(() => rbac.assertAtLeast('guest', 'member', 'ask'), /requires member/);
  // And is silent when the tier is sufficient, including exactly equal.
  rbac.assertAtLeast('admin', 'admin', 'roster');
  rbac.assertAtLeast('super_admin', 'member', 'ask');
});

test('SECURITY: members and guests are never offered an admin or super-admin tool', () => {
  for (const role of ['member', 'guest'] as const) {
    const tools = rbac.toolsForRole(role);
    for (const privileged of [...ADMIN, ...SUPER_ADMIN]) {
      assert.ok(!tools.includes(privileged), `${role} must not be offered ${privileged}`);
    }
    assert.deepEqual(tools, [...MEMBER], `${role} gets exactly the member surface`);
  }
});

test('SECURITY: an admin is never offered a super-admin tool', () => {
  const tools = rbac.toolsForRole('admin');
  for (const privileged of SUPER_ADMIN) {
    assert.ok(!tools.includes(privileged), `admin must not be offered ${privileged}`);
  }
  assert.deepEqual(tools, [...MEMBER, ...ADMIN]);
});

test('SECURITY: the surface is cumulative upward — each tier is a superset of the one below', () => {
  // Stated as a property rather than three fixed lists: a future tier list
  // that accidentally REPLACED the lower surface instead of extending it would
  // satisfy the two tests above (nothing privileged leaked downward) while
  // silently taking tools away from admins.
  const guest = new Set(rbac.toolsForRole('guest'));
  const member = new Set(rbac.toolsForRole('member'));
  const admin = new Set(rbac.toolsForRole('admin'));
  const superAdmin = new Set(rbac.toolsForRole('super_admin'));

  for (const [lower, higher, names] of [
    [guest, member, 'guest ⊆ member'],
    [member, admin, 'member ⊆ admin'],
    [admin, superAdmin, 'admin ⊆ super_admin'],
  ] as const) {
    for (const tool of lower) assert.ok(higher.has(tool), `${names}: ${tool} missing from the higher tier`);
  }
  assert.equal(superAdmin.size, MEMBER.length + ADMIN.length + SUPER_ADMIN.length);
});

test('SECURITY: a guest gets the member surface and nothing more', () => {
  // Guests only ever reach the agent at all in open mode; when they do, the
  // surface is exactly a member's — never a wider one, and never a special
  // "unauthenticated" list that could drift on its own.
  assert.deepEqual(rbac.toolsForRole('guest'), rbac.toolsForRole('member'));
});

test('SECURITY: Discord-only tools are dropped from the surface on other platforms', () => {
  // Not merely refused by the handler: not offered. A tool the model can never
  // successfully call on this platform is a schema it can be talked into
  // trying, and a refusal it can be talked into reporting as a failure.
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    const whatsapp = rbac.toolsForRole(role, 'whatsapp');
    for (const discordOnly of DISCORD_ONLY) {
      if (rbac.toolsForRole(role, 'discord').includes(discordOnly)) {
        assert.ok(!whatsapp.includes(discordOnly), `${role}/whatsapp must not be offered ${discordOnly}`);
      }
    }
  }
  assert.deepEqual(rbac.toolsForRole('member', 'whatsapp'), ['mcp__t__ask', 'mcp__t__search']);
  assert.deepEqual(rbac.toolsForRole('admin', 'whatsapp'), [
    'mcp__t__ask',
    'mcp__t__search',
    'mcp__t__roster',
  ]);
});

test('the platform filter applies to an unknown platform too, not only to whatsapp', () => {
  // `Platform` is an open string — adapters register their own name — so the
  // filter must be "not discord", not a hardcoded list of the two platforms
  // that exist today. A new adapter must not inherit the Discord surface.
  assert.deepEqual(rbac.toolsForRole('member', 'signal'), ['mcp__t__ask', 'mcp__t__search']);
});

test('the platform argument defaults to the full Discord surface', () => {
  assert.deepEqual(rbac.toolsForRole('admin'), rbac.toolsForRole('admin', 'discord'));
  assert.ok(rbac.toolsForRole('admin').includes('mcp__t__react'));
});

test('toolsForRole hands back a fresh array each call', () => {
  // The caller gets a list it may sort or filter; doing so must not reach the
  // registry, and two callers must not share one array.
  const first = rbac.toolsForRole('admin');
  const second = rbac.toolsForRole('admin');
  assert.notEqual(first, second);
  first.push('mcp__t__smuggled');
  assert.ok(!rbac.toolsForRole('admin').includes('mcp__t__smuggled'));
  assert.deepEqual(rbac.MEMBER_TOOLS, [...MEMBER]);
});

test('SECURITY: tiers cannot be re-registered — the surface is fixed at boot', () => {
  // Declared LAST: it is the only case that cannot be followed by another
  // registration in this process. A swap after boot would let anything that
  // can reach this function rewrite the tool surface of a running agent.
  assert.throws(
    () =>
      rbac.registerToolTiers({
        member: [...MEMBER, ...ADMIN, ...SUPER_ADMIN],
        admin: [],
        superAdmin: [],
        discordOnly: [],
      }),
    /already registered/,
  );
  // And the original surface is untouched by the attempt.
  assert.deepEqual(rbac.toolsForRole('member'), [...MEMBER]);
});
