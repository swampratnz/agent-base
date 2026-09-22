import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
// config.ts reads env at import time, so the tier under test is set before
// anything that loads it; a sibling file covers the other non-default value.
process.env.AGENT_WEB_SEARCH_TIER = 'none';

// WattoBot #100: the base granted the SDK's built-in WebSearch to every
// admin+ turn with no switch a module could reach, so its results bypassed
// the module's fence, footer, provenance set and budget. `none` is the
// module's off switch. Same synthetic tool registration as toolLockdown.test.ts.
const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { buildQueryOptions } = await import('../src/agent/core.js');

registerToolTiers({ member: ['mcp__t__ask'], admin: ['mcp__t__moderate'], superAdmin: [], discordOnly: [] });
registerFlaggedToolPredicates([]);

test('SECURITY: with AGENT_WEB_SEARCH_TIER=none NO tier is granted, pre-approved or hooked for the built-in WebSearch, and every tier disallows it', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'system prompt', {}, null, 'conv-1', 'discord');
    assert.ok(!opts.tools.includes('WebSearch'), `${role} must not be granted WebSearch`);
    assert.ok(!opts.allowedTools.includes('WebSearch'), `${role} must not pre-approve WebSearch`);
    assert.ok(opts.disallowedTools.includes('WebSearch'), `${role} must disallow WebSearch`);
    assert.equal((opts as { hooks?: unknown }).hooks, undefined, `${role} gets no WebSearch hooks either`);
  }
});
