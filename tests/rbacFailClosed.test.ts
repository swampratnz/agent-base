import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// Kept as a NAMESPACE, not destructured: `MEMBER_TOOLS` and friends are live
// bindings, and `const { MEMBER_TOOLS } = ...` would snapshot a value rather
// than observe one.
const rbac = await import('../src/auth/rbac.js');

/**
 * The tier surface BEFORE any module registers — its own file, because
 * `registerToolTiers` is once-per-process and this is the only state that
 * cannot be reached again afterwards.
 *
 * Keeping it here rather than as the first test in `rbac.test.ts` removes an
 * ordering dependency that would otherwise be invisible until something ran a
 * SUBSET of that file: `npm run test:security` executes only the
 * `SECURITY:`-prefixed cases, so a plain registration test sitting between two
 * security cases would silently not run, and every derived assertion after it
 * would fail on an unregistered registry. `node:test` runs files in separate
 * processes, so this file's registry stays empty no matter what else runs.
 */
test('SECURITY: the tool surface fails closed before any module registers tiers', () => {
  assert.equal(rbac.areToolTiersRegistered(), false);

  // Not an empty list, not a default list: undefined. A `[]` would be a
  // narrower surface that still LOOKS like an answer, and the danger is the
  // symmetric case — anything answering with a wider list before registration
  // would be handing out tools nobody registered.
  assert.equal(rbac.MEMBER_TOOLS, undefined);
  assert.equal(rbac.ADMIN_TOOLS, undefined);
  assert.equal(rbac.SUPER_ADMIN_TOOLS, undefined);

  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.throws(
      () => rbac.toolsForRole(role),
      /no tool tiers registered/,
      `toolsForRole('${role}') must throw, not return a surface nobody registered`,
    );
  }
});

test('SECURITY: the fail-closed message names the fix that actually works', () => {
  // Diagnosability is the security property here. This message used to tell
  // the reader to "import the tool registry (src/module/agent/tools/index.js)"
  // — a path in the CONSUMER's repository, describing composition by
  // side-effect import, which `createAgent` replaced precisely because a
  // forgotten import surfaced as a narrower tool surface at first use. Someone
  // who follows the old advice reaches for the wrong lever entirely.
  let message = '';
  try {
    rbac.toolsForRole('member');
    assert.fail('toolsForRole must throw before registration');
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /toolTiers/);
  assert.match(message, /manifest/);
  assert.doesNotMatch(message, /src\/module\//);
});
