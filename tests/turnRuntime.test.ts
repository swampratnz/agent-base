import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// G2 and G3: a module's per-turn runtime (where the CLI runs, with what
// built-ins) and a tool server that carries only the turn's own tools.
const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { buildQueryOptions, turnModuleToolIds } = await import('../src/agent/core.js');
const { ALL_BUILTIN_TOOLS, MUTATING_BUILTIN_TOOLS, armMutatingTools, resetArmingsForTest } =
  await import('../src/agent/builtinTools.js');
const { registerToolServerParts, buildToolServer } = await import('../src/agent/toolServer.js');
const { registerTurnRuntimeResolver, resetTurnRuntimeResolverForTest, resolveTurnRuntime } =
  await import('../src/agent/turnRuntime.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const MEMBER_TOOL = 'mcp__t__ask';
const ADMIN_TOOL = 'mcp__t__moderate';
registerToolTiers({ member: [MEMBER_TOOL], admin: [ADMIN_TOOL], superAdmin: [], discordOnly: [] });
registerFlaggedToolPredicates([]);

const ran: string[] = [];
registerToolServerParts({
  name: 't',
  makeContext: () => ({}),
  registry: [
    {
      name: 'ask',
      description: 'ask',
      schema: {},
      readOnlyHint: true,
      handler: async () => (ran.push('ask'), { content: [{ type: 'text', text: 'asked' }] }),
    },
    {
      name: 'moderate',
      description: 'moderate',
      schema: {},
      readOnlyHint: false,
      handler: async () => (ran.push('moderate'), { content: [{ type: 'text', text: 'moderated' }] }),
    },
  ],
});

const ACTOR = 'sa-1';
const CONVO = 'c1';
beforeEach(() => {
  resetArmingsForTest();
  resetTurnRuntimeResolverForTest();
  ran.length = 0;
});

type Hooked = { hooks?: { PreToolUse?: Array<{ matcher: string }> } };
const gateOn = (opts: unknown): boolean =>
  ((opts as Hooked).hooks?.PreToolUse ?? []).some((e) => e.matcher === MUTATING_BUILTIN_TOOLS.join('|'));

test('with no runtime the options are the base default: an armed super admin gets every built-in, the gate, a local cwd and env', () => {
  armMutatingTools('discord', CONVO, ACTOR);
  const opts = buildQueryOptions('super_admin', 'p', {}, null, CONVO, 'discord', ACTOR);
  assert.deepEqual(opts.tools, [...ALL_BUILTIN_TOOLS]);
  assert.deepEqual(opts.disallowedTools, []);
  assert.ok(gateOn(opts));
  assert.equal(typeof (opts as { cwd?: string }).cwd, 'string');
  assert.equal(typeof (opts as { env?: object }).env, 'object');
  assert.equal('spawnClaudeCodeProcess' in opts, false);
  assert.equal('sessionStore' in opts, false);
});

test('SECURITY: a policy that leaves out WebFetch and WebSearch removes them from an armed turn and disallows them (#379)', () => {
  armMutatingTools('discord', CONVO, ACTOR);
  const tools = ALL_BUILTIN_TOOLS.filter((t) => t !== 'WebFetch' && t !== 'WebSearch');
  const opts = buildQueryOptions('super_admin', 'p', {}, null, CONVO, 'discord', ACTOR, undefined, {
    builtins: { tools, armingGate: true },
  });
  assert.deepEqual(opts.tools, tools);
  for (const t of ['WebFetch', 'WebSearch']) {
    assert.ok(!opts.tools.includes(t), `${t} granted`);
    assert.ok(!opts.allowedTools.includes(t), `${t} pre-approved`);
    assert.ok(opts.disallowedTools.includes(t), `${t} not disallowed`);
  }
  assert.ok(gateOn(opts), 'the arming gate still guards the shell');
});

test('SECURITY: a policy with armingGate false and the shell tools grants them to an admin with no gate, and nothing else of the base changes', () => {
  const opts = buildQueryOptions('admin', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    builtins: { tools: ['Bash', 'Read', 'WebFetch', 'WebSearch'], armingGate: false },
    cwd: '/workspace',
  });
  assert.deepEqual(opts.tools, ['Bash', 'Read', 'WebFetch', 'WebSearch']);
  assert.deepEqual(opts.disallowedTools, ['Task']);
  assert.equal(gateOn(opts), false);
  assert.equal((opts as { cwd?: string }).cwd, '/workspace');
  assert.ok(opts.allowedTools.includes(ADMIN_TOOL));
});

test('an empty policy list is no built-ins, even for a tier that would have had web search', () => {
  const opts = buildQueryOptions('admin', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    builtins: { tools: [], armingGate: true },
  });
  assert.deepEqual(opts.tools, []);
  assert.deepEqual(opts.disallowedTools, ['Task', 'WebFetch', 'WebSearch']);
  assert.equal((opts as Hooked).hooks, undefined);
  assert.equal('cwd' in opts, false);
});

test('G2: the spawn function, env and session store are handed to the SDK as given', () => {
  const spawnClaudeCodeProcess = (() => {
    throw new Error('not called here');
  }) as never;
  const sessionStore = { append: async () => {}, load: async () => null };
  const env = { PATH: '/usr/bin' };
  const opts = buildQueryOptions('member', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    spawnClaudeCodeProcess,
    sessionStore,
    env,
    cwd: '/workspace',
  });
  assert.equal((opts as { spawnClaudeCodeProcess?: unknown }).spawnClaudeCodeProcess, spawnClaudeCodeProcess);
  assert.equal((opts as { sessionStore?: unknown }).sessionStore, sessionStore);
  assert.equal((opts as { env?: unknown }).env, env);
  assert.deepEqual(opts.tools, [], 'a member still has no built-ins when the runtime names none');
});

test('SECURITY: a runtime naming a tool that is not a built-in is refused, not passed on', async () => {
  registerTurnRuntimeResolver(() => ({ builtins: { tools: ['Bash', 'Bassh'], armingGate: false } }));
  const caller = {
    platform: 'web',
    userId: 'u',
    userName: 'u',
    role: 'admin',
    conversationId: 'c',
    isDirect: true,
  } as const;
  await assert.rejects(resolveTurnRuntime({ caller, armed: false }), /unknown built-in tools: Bassh/);
});

test('a resolver can be registered once only', () => {
  registerTurnRuntimeResolver(() => undefined);
  assert.throws(() => registerTurnRuntimeResolver(() => undefined), /already registered/);
});

async function connect(server: ReturnType<typeof buildToolServer>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'forger', version: '0' });
  await client.connect(clientSide);
  return client;
}

const member = {
  platform: 'web',
  userId: 'm',
  userName: 'm',
  role: 'member',
  conversationId: 'c',
  isDirect: true,
} as const;

test("SECURITY: a forged call to a tool outside the turn's list finds no such tool on the server and runs nothing (G3)", async () => {
  const server = buildToolServer(
    member,
    {} as never,
    undefined,
    {},
    undefined,
    turnModuleToolIds('member', 'web'),
  );
  const client = await connect(server);
  const listed = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(listed, ['ask']);
  const forged = await client.callTool({ name: 'moderate', arguments: {} }).then(
    (r) => r,
    (err: unknown) => ({ isError: true, thrown: String(err) }),
  );
  assert.equal((forged as { isError?: boolean }).isError, true, JSON.stringify(forged));
  assert.deepEqual(ran, [], 'the admin tool must not run');
  const allowed = await client.callTool({ name: 'ask', arguments: {} });
  assert.notEqual(allowed.isError, true);
  assert.deepEqual(ran, ['ask']);
});

test('the control: with no list, every registered tool is on the server, so the check above can see a difference', async () => {
  const server = buildToolServer(member, {} as never, undefined, {});
  const client = await connect(server);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['ask', 'moderate']);
});

type PostHooked = {
  hooks?: {
    PostToolUse?: Array<{ matcher: string; hooks: Array<(input: unknown) => Promise<unknown>> }>;
  };
};

test('SECURITY: the built-in sink hears each granted built-in by NAME only, never its input or output (WattoBot #386)', async () => {
  const heard: unknown[] = [];
  const opts = buildQueryOptions('admin', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    builtins: { tools: ['Bash', 'Read'], armingGate: false },
    onBuiltinToolUse: (use) => heard.push(use),
  }) as PostHooked;
  const entry = opts.hooks?.PostToolUse?.find((h) => h.matcher === 'Bash|Read');
  assert.ok(entry, 'one PostToolUse entry, matched to exactly the granted built-ins');
  const fire = (payload: unknown) => entry.hooks[0](payload);
  await fire({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat /secrets/token' },
    tool_response: { stdout: 'sk-live-XYZ' },
  });
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } });
  // A name outside the turn's list is dropped, whatever the matcher let in.
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'mcp__t__ask', tool_input: {} });
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://x' } });
  assert.deepEqual(heard, [{ tool: 'Bash' }, { tool: 'Read' }]);
  assert.ok(!JSON.stringify(heard).includes('secrets') && !JSON.stringify(heard).includes('sk-live'));
});

test('a sink that throws never fails the hook, and a turn with no built-ins or no sink attaches nothing', async () => {
  const throwing = buildQueryOptions('admin', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    builtins: { tools: ['Bash'], armingGate: false },
    onBuiltinToolUse: () => {
      throw new Error('module bug');
    },
  }) as PostHooked;
  const entry = throwing.hooks?.PostToolUse?.find((h) => h.matcher === 'Bash');
  assert.ok(entry);
  assert.deepEqual(await entry.hooks[0]({ tool_name: 'Bash' }), { continue: true });

  const none = buildQueryOptions('admin', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    builtins: { tools: [], armingGate: false },
    onBuiltinToolUse: () => assert.fail('never called'),
  }) as PostHooked;
  assert.equal(none.hooks, undefined, 'no built-ins, no hook: the options are what they were');
  const unsinked = buildQueryOptions('admin', 'p', {}, null, CONVO, 'web', 'u1', undefined, {
    builtins: { tools: ['Bash'], armingGate: false },
  }) as PostHooked;
  assert.equal(unsinked.hooks, undefined, 'no sink, no hook');
});
