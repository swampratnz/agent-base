import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES } = await import('./fixtures/noticePack.js');
import type { AgentModule } from '../src/createAgent.js';
import type { ToolServerParts } from '../src/agent/toolServer.js';
const { createAgent, assertRegistrationsComplete, planComposition } = await import('../src/createAgent.js');
const { PRE_TURN_SPINE, registerPreTurnIntercept, registeredPreTurnIntercepts } =
  await import('../src/routerIntercepts.js');
const { toolsForRole } = await import('../src/auth/rbac.js');
const { defaultPersonaId } = await import('../src/agent/personaRegistry.js');
const { runtimeSecrets } = await import('../src/agent/secrets.js');

/**
 * `createAgent` — the composition entry point that replaces community-agent's
 * side-effect-import composition root.
 *
 * The registries it drives are all ONCE-PER-PROCESS by design, and this file
 * is one process, so the ordering-and-completeness assertions run against a
 * single successful composition and the failure cases are exercised with
 * everything they need to reach the specific check under test. `node:test`
 * runs test FILES in separate processes, so no other file is affected.
 */

/**
 * A module's own per-turn tool context — the thing `makeContext` builds and
 * every handler receives. A real one carries the caller, the adapter and the
 * turn state; two fields is enough to make the type distinct from `unknown`,
 * which is the whole point of the fixtures below.
 */
interface TestToolContext {
  callerId: string;
  isAdmin: boolean;
}

/**
 * Real tool-server parts over `TestToolContext` — the shape a module actually
 * has, written with NO cast.
 *
 * This is a compile-time regression test for 0.1.0's
 * `toolServerParts?: ToolServerParts<never>`, which was uninhabitable
 * (`makeContext` returns the context, and only `never` is assignable to
 * `never`), so the first consumer had to write
 * `PARTS as unknown as AgentModule['toolServerParts']`. `tsconfig.tests.json`
 * lists this file, so `npm run typecheck` fails if the field ever becomes
 * unsatisfiable again.
 */
const TYPED_PARTS: ToolServerParts<TestToolContext> = {
  name: 't',
  makeContext: (caller) => ({ callerId: caller.userId, isAdmin: caller.role === 'admin' }),
  registry: [
    {
      name: 'mcp__t__ask',
      description: 'ask',
      schema: {},
      readOnlyHint: true,
      // `ctx` is TestToolContext here, not `unknown` — a handler that reads a
      // context field is exactly what the cast used to hide.
      handler: (_args, ctx) => Promise.resolve({ content: [{ type: 'text' as const, text: ctx.callerId }] }),
    },
  ],
};

/** Pinned `Ctx`: every handler is checked against the module's real context. */
const PINNED_CTX_MODULE: AgentModule<TestToolContext> = { name: 'pinned', toolServerParts: TYPED_PARTS };

/**
 * Unpinned: the bare `AgentModule` a consumer writes when it does not care to
 * name its context type still takes the same parts object, cast-free.
 */
const DEFAULTED_CTX_MODULE: AgentModule = { name: 'defaulted', toolServerParts: TYPED_PARTS };

/** A complete, minimal module: exactly enough to satisfy every requirement. */
function completeModule(overrides: Partial<AgentModule> = {}): AgentModule {
  return {
    name: 'test-module',
    notices: { axes: TEST_NOTICE_AXES, entries: TEST_NOTICE_ENTRIES },
    toolTiers: { member: ['mcp__t__ask'], admin: [], superAdmin: [], discordOnly: [] },
    toolServerParts: TYPED_PARTS,
    flaggedToolPredicates: [],
    skills: { enabledSkills: ['getting-started'], skillsDir: '/tmp/skills' },
    promptSections: {
      charter: 'charter',
      behaviourGuidelines: 'behaviour',
      recallEtiquette: 'recall',
      conductGuidance: 'conduct',
      promptReviewClause: 'review',
      webSearchAuthority: 'authority',
      dateLine: () => '- Date: today',
      responseStyleSections: { simple: 'simple style' },
      languagePreferenceSections: { xx: 'xx guidance' },
    },
    commands: [],
    defaultBadWords: ['badword'],
    personas: [{ persona: { id: 'default', name: 'Default', voice: 'plain', aliases: [] }, isDefault: true }],
    ...overrides,
  };
}

test('a module supplies real tool-server parts over its own context type, with no cast', () => {
  // The assertions here are trivial by design — the test is the DECLARATIONS
  // above, which `npm run typecheck` compiles. This body only keeps them from
  // being dead code, and pins that a pinned-`Ctx` and a defaulted-`Ctx`
  // module carry the identical parts object rather than a widened copy.
  assert.equal(PINNED_CTX_MODULE.toolServerParts, TYPED_PARTS);
  assert.equal(DEFAULTED_CTX_MODULE.toolServerParts, TYPED_PARTS);
  // Both go through `planComposition` as ordinary modules: the type parameter
  // is erased, so a heterogeneous module list composes as it always did.
  assert.throws(
    () => planComposition([PINNED_CTX_MODULE, DEFAULTED_CTX_MODULE]),
    /tool-server parts/,
    'two modules claiming the same singleton is still a plan-pass rejection',
  );
});

test('createAgent rejects a composition it cannot serve a turn with, naming EVERY gap at once', async () => {
  // The whole point of the gate: community-agent discovered a forgotten
  // composition-root import at first use — a thrown accessor or a blank
  // member-facing string, one at a time. Here it is one startup error
  // listing all of them, raised by the PURE plan pass, so nothing has been
  // registered by the time it throws.
  await assert.rejects(
    createAgent({ modules: [{ name: 'empty' }] }),
    (err: Error) =>
      /9 problem\(s\) with this composition/.test(err.message) &&
      err.message.includes('notice pack') &&
      err.message.includes('tool tiers') &&
      err.message.includes('tool-server parts') &&
      err.message.includes('flagged-tool predicates') &&
      err.message.includes('skills manifest') &&
      err.message.includes('prompt sections') &&
      err.message.includes('commands') &&
      err.message.includes('default bad words') &&
      err.message.includes('default persona'),
  );
});

test('createAgent rejects an empty module list and duplicate module names', async () => {
  await assert.rejects(createAgent({ modules: [] }), /no modules supplied/);
  await assert.rejects(
    createAgent({ modules: [{ name: 'dup' }, { name: 'dup' }] }),
    /duplicate module name 'dup'/,
  );
  // A persona roster with no default is NOT a claim: `defaultPersonaId()`
  // would still fail closed, so the plan pass says so rather than letting
  // boot get further.
  assert.throws(
    () =>
      planComposition([
        completeModule({ personas: [{ persona: { id: 'p', name: 'P', voice: 'v', aliases: [] } }] }),
      ]),
    /default persona \(no module supplied `personas`\)/,
  );
});

test('createAgent refuses two claimants for a once-per-process registry, naming BOTH modules', async () => {
  await assert.rejects(
    createAgent({
      modules: [
        { name: 'first', defaultBadWords: ['a'] },
        { name: 'second', defaultBadWords: ['b'] },
      ],
    }),
    /modules 'first' and 'second' both supply the default bad words/,
  );
});

test('a complete composition registers everything, appends intercepts after the frozen spine, and gates start()', async () => {
  const ordering: string[] = [];
  const agent = await createAgent({
    modules: [
      completeModule({
        init: () => {
          ordering.push('init');
          // init runs BEFORE any registration, so it cannot observe another
          // module's registrations and cannot race them.
          assert.throws(() => defaultPersonaId(), /no default persona registered/);
        },
        preTurnIntercepts: [
          {
            name: 'module-intercept',
            run: () => Promise.resolve('continue'),
          },
        ],
        runtimeSecrets: [() => 'manifest-registered-secret-000'],
        migrations: [{ name: 'test-module/01.sql', sql: 'SELECT 1;' }],
      }),
    ],
    // The lifted DB-backed suite owns migration coverage; this test is about
    // composition, and must not depend on a reachable Postgres.
    migrateOnStart: false,
  });

  assert.deepEqual([...agent.modules], ['test-module']);
  assert.equal(agent.started, false);
  assert.throws(() => agent.assertStarted(), /has not started/);

  // Registration actually happened.
  assertRegistrationsComplete();
  assert.equal(defaultPersonaId(), 'default');
  assert.ok(toolsForRole('member').includes('mcp__t__ask'));

  // The module's intercept landed in the POST-SPINE region — the only place
  // registration can reach. `registeredPreTurnIntercepts()` is exactly that
  // region; `Router.preTurnChain()` runs the frozen spine ahead of it.
  const intercepts = registeredPreTurnIntercepts();
  assert.deepEqual(
    intercepts.map((i) => i.name),
    ['module-intercept'],
  );
  // And there is no route by which createAgent could smuggle one INTO the
  // spine: reusing a spine step's name is refused outright.
  assert.throws(
    () => registerPreTurnIntercept({ name: PRE_TURN_SPINE[0], run: () => Promise.resolve('continue') }),
    /collides with a security-spine step/,
  );

  await agent.start(() => {
    ordering.push('run');
  });
  assert.equal(agent.started, true);
  assert.deepEqual(ordering, ['init', 'run']);
  agent.assertStarted();

  await assert.rejects(agent.start(), /already started/);
});

test('SECURITY: a manifest-registered runtime secret reaches the outbound redaction backstop', async () => {
  // The property under test is the WIRING: a module that declares the field
  // needs no further step for its credential to be covered on every adapter
  // send path — the gap PHASE-4 §8.2 names is closed by the manifest alone.
  //
  // Under `npm test` the complete composition above already registered the
  // getter. Under the floor gate's `--test-name-pattern=^SECURITY:` run that
  // test never ran and the singletons are unclaimed, so compose here — the
  // check makes this test self-sufficient in both run modes.
  if (!runtimeSecrets().includes('manifest-registered-secret-000')) {
    await createAgent({
      modules: [completeModule({ runtimeSecrets: [() => 'manifest-registered-secret-000'] })],
      migrateOnStart: false,
    });
  }
  assert.ok(
    runtimeSecrets().includes('manifest-registered-secret-000'),
    "a module's manifest-declared secret must be in the exact-value redaction list",
  );
});

test('SECURITY: an incomplete composition never yields an Agent at all — there is nothing to start', async () => {
  // The gate is not advisory. `createAgent` rejects rather than returning a
  // degraded agent, so there is no object a caller could `start()` with a
  // narrower tool surface, an unregistered moderation floor, or a notice
  // pack that would throw in front of a member.
  let handle: unknown;
  let initRan = false;
  try {
    handle = await createAgent({
      modules: [
        {
          name: 'partial',
          personas: [{ persona: { id: 'x', name: 'X', voice: 'v', aliases: [] }, isDefault: true }],
          init: () => {
            initRan = true;
          },
        },
      ],
    });
  } catch {
    handle = undefined;
  }
  assert.equal(handle, undefined);
  assert.equal(initRan, false, 'a doomed composition must not run a module init hook either');
});
