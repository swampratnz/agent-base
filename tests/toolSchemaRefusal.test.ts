import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// WattoBot #105. On @anthropic-ai/claude-agent-sdk 0.3.274 (CLI 2.1.274) one
// tool whose JSON schema carries `propertyNames` (a `z.record`) or `allOf` (a
// `z.intersection`) makes the CLI drop EVERY tool on the SDK MCP server: the
// `init` message lists `tools: []` while the server reads `connected`, and the
// turn ends `success` with the model explaining it has no tools. The base then
// reported `ok: true`. Two defences, both pinned here: refuse such a registry
// at boot, and refuse a turn whose `init` does not advertise the tools it was
// given. The SDK is mocked so the second is proven against the stream shape
// the real CLI produced, without a paid call.

const realSdk = await import('@anthropic-ai/claude-agent-sdk');
type Msg = Record<string, unknown>;
let script: Msg[] = [];
let lastOptions: Record<string, unknown> | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...realSdk,
    query: (args: { options?: Record<string, unknown> }) => {
      lastOptions = args.options;
      return (async function* () {
        for (const m of script) yield m;
      })();
    },
  },
});

const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerNoticePack } = await import('../src/strings/catalogue.js');
const { TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES } = await import('./fixtures/noticePack.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { registerToolServerParts, refusedSchemaKeywords } = await import('../src/agent/toolServer.js');
import type { ToolServerToolDef } from '../src/agent/toolServer.js';
const { execTurn } = await import('../src/agent/core.js');
const { logger } = await import('../src/logger.js');
import type { PlatformAdapter } from '../src/platforms/types.js';
import type { CallerContext } from '../src/auth/rbac.js';

const ok = { content: [{ type: 'text' as const, text: 'ok' }] };
const ping = {
  name: 'ping',
  description: 'pong',
  schema: { note: z.string().optional() },
  readOnlyHint: true,
  handler: async () => ok,
};
const parts = (registry: ToolServerToolDef<unknown>[]) => ({ name: 't', makeContext: () => ({}), registry });

registerToolTiers({ member: ['mcp__t__ping', 'mcp__t__probe'], admin: [], superAdmin: [], discordOnly: [] });
registerFlaggedToolPredicates([]);
// The refused-turn path serves a notice, which needs a complete pack, as createAgent registers one.
registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
// The clean registry the runtime tests drive, registered at module scope so
// the SECURITY-only run (which skips the boot-refusal tests) sees it too;
// the refusal tests still throw because the schema check runs before the
// already-registered guard.
registerToolServerParts(parts([ping, { ...ping, name: 'probe' }]));

test('a registry with a z.record tool is refused at boot, naming the tool and the keyword', () => {
  const rec = { ...ping, name: 'probe', schema: { args: z.record(z.string(), z.string()) } };
  assert.throws(() => registerToolServerParts(parts([ping, rec])), /probe \(propertyNames\)/);
});

test('a registry with a z.intersection tool is refused at boot too — allOf drops the server just the same', () => {
  const both = {
    ...ping,
    name: 'probe',
    schema: { v: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })) },
  };
  assert.throws(() => registerToolServerParts(parts([ping, both])), /probe \(allOf\)/);
  assert.deepEqual(refusedSchemaKeywords(both.schema), ['allOf']);
});

test('the constructs the CLI accepts pass the boot check, so the check refuses only what was reproduced', () => {
  const fine = {
    u: z.union([z.string(), z.number()]),
    e: z.enum(['a', 'b']),
    n: z.string().nullable(),
    o: z.looseObject({ a: z.string() }),
    c: z.object({ a: z.string() }).catchall(z.number()),
    d: z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]),
    t: z.tuple([z.string(), z.number()]),
    s: z.string().min(1).max(10).default('x'),
  };
  assert.deepEqual(refusedSchemaKeywords(fine), []);
});

const caller: CallerContext = {
  platform: 'discord',
  userId: 'u1',
  conversationId: 'c1',
  role: 'member',
} as CallerContext;
const adapter = {} as PlatformAdapter;
const init = (tools: string[]): Msg => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  tools,
  mcp_servers: [{ name: 't', status: 'connected' }],
});
const success = (text: string): Msg => ({
  type: 'result',
  subtype: 'success',
  session_id: 's1',
  result: text,
  total_cost_usd: 0.001,
});

test('SECURITY: a turn whose init advertises none of its registered tools is refused and logged at error level, never answered as ok', async () => {
  script = [init([]), success("I don't have access to a ping tool in my available tools.")];
  const errors: unknown[] = [];
  const restore = mock.method(logger, 'error', (...args: unknown[]) => errors.push(args));
  try {
    const outcome = await execTurn(caller, 'call ping', 'system prompt', adapter, null);
    assert.equal(outcome.ok, false, 'a toolless turn that was meant to have tools is a failed turn');
    assert.equal(outcome.fallbackNoticeId, 'internalErrorReply');
    assert.notEqual(
      outcome.text,
      "I don't have access to a ping tool in my available tools.",
      'the toolless answer never reaches the member',
    );
    const logged = JSON.stringify(errors);
    assert.match(logged, /mcp__t__ping/, 'the log names the missing tool');
    assert.match(logged, /mcp__t__probe/);
  } finally {
    restore.mock.restore();
  }
});

test('a turn whose init advertises every registered tool it was given runs to its result as before', async () => {
  script = [init(['mcp__t__ping', 'mcp__t__probe']), success('pong')];
  const outcome = await execTurn(caller, 'call ping', 'system prompt', adapter, null);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, 'pong');
  assert.deepEqual((lastOptions as { allowedTools: string[] }).allowedTools, [
    'mcp__t__ping',
    'mcp__t__probe',
  ]);
});
