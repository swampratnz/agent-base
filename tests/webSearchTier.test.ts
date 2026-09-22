import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.AGENT_WEB_SEARCH_TIER = 'super_admin';

// WattoBot #100, the two halves beyond the off switch (webSearchTierNone.test.ts):
// the grant can be raised to super_admin only, and a built-in search that ran
// is reported to the caller with its query and result URLs, so a module can
// fence, footer and attribute results that never crossed its tool wrapper.
const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { buildQueryOptions, builtinWebSearchUse } = await import('../src/agent/core.js');
import type { BuiltinWebSearchUse } from '../src/agent/turnState.js';

registerToolTiers({ member: ['mcp__t__ask'], admin: ['mcp__t__moderate'], superAdmin: [], discordOnly: [] });
registerFlaggedToolPredicates([]);

type Hooked = {
  hooks?: Record<string, Array<{ matcher: string; hooks: Array<(input: unknown) => Promise<unknown>> }>>;
};

test('AGENT_WEB_SEARCH_TIER=super_admin withholds the built-in from admin and grants it to super_admin', () => {
  const admin = buildQueryOptions('admin', 'system prompt', {}, null, 'conv-1', 'discord');
  assert.ok(!admin.tools.includes('WebSearch'));
  assert.ok(admin.disallowedTools.includes('WebSearch'));
  const superAdmin = buildQueryOptions('super_admin', 'system prompt', {}, null, 'conv-1', 'discord');
  assert.deepEqual(superAdmin.tools, ['WebSearch']);
  assert.ok(!superAdmin.disallowedTools.includes('WebSearch'));
});

test('a built-in WebSearch that ran is reported to the sink with its query and every result URL', async () => {
  const seen: BuiltinWebSearchUse[] = [];
  const opts = buildQueryOptions('super_admin', 'system prompt', {}, null, 'conv-1', 'discord', '', (u) =>
    seen.push(u),
  ) as Hooked;
  const post = opts.hooks?.PostToolUse?.find((h) => h.matcher === 'WebSearch');
  assert.ok(post, 'a PostToolUse hook is attached for WebSearch when a sink is supplied');
  const out = await post.hooks[0]({
    hook_event_name: 'PostToolUse',
    tool_name: 'WebSearch',
    tool_input: { query: 'nz contractor tax' },
    tool_response: {
      query: 'nz contractor tax',
      results: [
        'Some commentary from the model',
        { tool_use_id: 'srvtoolu_1', content: [{ title: 'IRD', url: 'https://ird.govt.nz/a' }] },
        { tool_use_id: 'srvtoolu_2', content: [{ title: 'Guide', url: 'https://example.com/b' }] },
      ],
      durationSeconds: 1.2,
    },
  });
  assert.deepEqual(out, { continue: true }, 'the recorder never blocks or rewrites the call');
  assert.deepEqual(seen, [
    { query: 'nz contractor tax', urls: ['https://ird.govt.nz/a', 'https://example.com/b'] },
  ]);
});

test('an unexpected PostToolUse payload yields an empty use rather than a thrown hook', () => {
  assert.deepEqual(builtinWebSearchUse(undefined), { query: '', urls: [] });
  assert.deepEqual(builtinWebSearchUse({ tool_response: { results: 'not a list' } }), {
    query: '',
    urls: [],
  });
});

test('no sink means no PostToolUse hook, so the synthetic call sites see the options they always did', () => {
  const opts = buildQueryOptions('super_admin', 'system prompt', {}, null, 'conv-1', 'discord') as Hooked;
  assert.equal(opts.hooks?.PostToolUse, undefined);
  assert.ok(
    opts.hooks?.PreToolUse?.some((h) => h.matcher === 'WebSearch'),
    'the rate cap is still attached',
  );
});
