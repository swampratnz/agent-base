import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES } = await import('./fixtures/noticePack.js');
import type { AgentModule } from '../src/createAgent.js';
import type { FleetHeartbeat } from '../src/fleet/heartbeat.js';
import type { Queryable } from '../src/storage/repository/shared.js';
const { createAgent } = await import('../src/createAgent.js');

/**
 * `createAgent` starts the bosun fleet reporter — the wiring, not the reporter.
 *
 * `tests/fleetHeartbeat.test.ts` covers what the reporter does (the spend
 * query, the watermark, failure handling). What is proven here is the one
 * thing that file cannot: that a deployment gets it WITHOUT doing anything.
 * The gap this closes was real — the reporter shipped in 0.6.2 with no caller,
 * so every agent-base process under bosun reported a daily spend of zero while
 * looking perfectly healthy.
 *
 * Its own file because `createAgent`'s registries are once-per-process, so a
 * process gets exactly one successful composition and `start()` runs once in
 * it. `node:test` runs test FILES in separate processes; `createAgent.test.ts`
 * spends its composition on the unconfigured path.
 *
 * The module fixture below is deliberately a local copy of that file's
 * `completeModule`. Sharing it would mean moving `TYPED_PARTS` out of a file
 * `tsconfig.tests.json` names, and that placement is itself a compile-time
 * regression test (see the comment on it there).
 */
function completeModule(overrides: Partial<AgentModule> = {}): AgentModule {
  return {
    name: 'fleet-test-module',
    notices: { axes: TEST_NOTICE_AXES, entries: TEST_NOTICE_ENTRIES },
    toolTiers: { member: [], admin: [], superAdmin: [], discordOnly: [] },
    toolServerParts: {
      name: 't',
      makeContext: () => ({}),
      registry: [],
    },
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

const FLEET_ENV = {
  FLEET_AGENT_ID: 'community-agent-01',
  FLEET_AGENT_TYPE: 'community-agent',
  FLEET_SUPERVISOR_URL: 'http://127.0.0.1:7177',
};

test('start(): a supervised agent reports itself, with no wiring in the module', async () => {
  const posts: string[] = [];
  const fetchImpl = ((url: string | URL) => {
    posts.push(String(url));
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as unknown as typeof fetch;

  let queried = false;
  const db: Queryable = {
    query: (async (_sql: string, _params: unknown[]) => {
      queried = true;
      return { rows: [] };
    }) as Queryable['query'],
  };

  const agent = await createAgent({
    modules: [completeModule()],
    // Composition is the subject; a reachable Postgres is not.
    migrateOnStart: false,
    fleet: { env: FLEET_ENV, deps: { db, fetchImpl } },
  });

  // Before start there is nothing to report to: no process is live yet.
  // Read into a local first — `assert.equal` is an assertion signature, so
  // asserting on the property directly would narrow it to `null` for the rest
  // of the test and the check after start() could never fail.
  const before: FleetHeartbeat | null = agent.fleetHeartbeat;
  assert.equal(before, null);

  await agent.start();

  const hb: FleetHeartbeat | null = agent.fleetHeartbeat;
  assert.ok(hb, 'a configured supervisor must get a reporter');
  // Registration is what flips bosun's row out of `starting`; without it the
  // agent is never health-checked. It is fire-and-forget inside start(), so
  // let its microtask land before reading the record.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts, ['http://127.0.0.1:7177/agents/community-agent-01/ready']);
  assert.equal(queried, false, 'registration reports liveness, not spend — the first beat does that');

  // Idempotent shutdown, and nothing holds the process open: the interval is
  // unref'd, which is why a module that never stops it is still correct.
  hb.stop();
  hb.stop();
});
