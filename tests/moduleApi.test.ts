import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES } = await import('./fixtures/noticePack.js');

// Deliberately imported from the BARREL, not from the files that define them —
// that is the whole subject of this file. `createAgent.test.ts` covers the
// composition behaviour; this covers what a consumer gets when it writes
// `import type { ... } from '@swampratnz/agent-base'`.
import type { AgentModule, AgentModuleManifest, ToolDef, ToolServerParts } from '../src/index.js';
const { defineTool, planComposition } = await import('../src/index.js');

/**
 * The barrel's type surface.
 *
 * Until 0.1.1 this file described a module written against `src/module-api/` —
 * the v0 contract types, sketched before the extraction. They were exported
 * from the barrel next to the real ones, so the package advertised TWO
 * `AgentModule`s (issue #10) and a `ToolDef` the tool server would reject: the
 * v0 one took a full zod type and a `capabilityLine`, the live one takes a
 * `ZodRawShape` and a `readOnlyHint`. Neither mismatch could fail anything,
 * because the only consumer imported the live types by their deep paths.
 *
 * So this file no longer tests a contract document. It tests that the barrel
 * hands out the live types — mostly at COMPILE time, which is where the bug
 * lived. `tsconfig.tests.json` lists this file, so `npm run typecheck` is the
 * assertion for everything below that has no runtime form.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A module's own per-turn tool context — base never looks inside it. */
interface DemoToolContext {
  callerId: string;
}

/**
 * A tool written the way a module writes one, against the barrel's `ToolDef`.
 * If that type ever reverts to a sketch, this stops compiling: the v0 shape
 * had no `readOnlyHint`, required a `capabilityLine`, and typed `schema` as a
 * full zod object rather than the raw shape the SDK's `tool()` helper takes.
 */
const echoTool = defineTool({
  name: 'echo',
  description: 'Echo the input back.',
  minTier: 'member',
  readOnlyHint: true,
  schema: {},
  handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
});

/** Real parts over a real context, cast-free — as `createAgent` takes them. */
const parts: ToolServerParts<DemoToolContext> = {
  name: 'demo',
  makeContext: (caller) => ({ callerId: caller.userId }),
  registry: [
    {
      name: 'mcp__demo__echo',
      description: echoTool.description,
      schema: echoTool.schema,
      readOnlyHint: echoTool.readOnlyHint,
      handler: (_args, ctx) => Promise.resolve({ content: [{ type: 'text' as const, text: ctx.callerId }] }),
    },
  ],
};

/**
 * A complete, minimal composition, typed with the BARREL's `AgentModule`. It
 * has to satisfy every requirement `planComposition` checks, which is what
 * makes the type identity meaningful rather than nominal: a manifest typed
 * against the wrong `AgentModule` would not typecheck here, and one typed
 * against the right shape but missing a registry would not pass at runtime.
 */
const demoModule: AgentModule<DemoToolContext> = {
  name: 'demo',
  notices: { axes: TEST_NOTICE_AXES, entries: TEST_NOTICE_ENTRIES },
  toolTiers: { member: ['mcp__demo__echo'], admin: [], superAdmin: [], discordOnly: [] },
  toolServerParts: parts,
  flaggedToolPredicates: [],
  skills: { skillsDir: '/tmp/skills', enabledSkills: ['getting-started'] },
  // The CLOSED slot set: every field required, so a module supplies all of
  // them or registration throws. Writing it out is the point — an open set
  // would let registration introduce prompt text at an unreviewed position.
  promptSections: {
    charter: 'You are the demo agent.',
    behaviourGuidelines: 'behaviour',
    recallEtiquette: 'recall',
    conductGuidance: 'conduct',
    promptReviewClause: 'review',
    webSearchAuthority: 'authority',
    dateLine: () => '- Date: today',
    responseStyleSections: {},
    languagePreferenceSections: {},
  },
  commands: [],
  defaultBadWords: ['badword'],
  personas: [{ persona: { id: 'demo', name: 'Demo', voice: 'plain', aliases: [] }, isDefault: true }],
  migrations: [
    { name: 'demo-core', sql: 'CREATE TABLE IF NOT EXISTS demo_items (id BIGSERIAL PRIMARY KEY);' },
  ],
};

test('the barrel AgentModule is the one createAgent takes', () => {
  // Runtime half: the pure plan pass accepts it. This has no side effects, so
  // it says nothing about the process — only that the manifest is complete.
  planComposition([demoModule]);

  // Compile-time half: `AgentModuleManifest` is an ALIAS, not a second type.
  // Assigning in both directions is the assertion; the runtime check is a
  // formality that keeps the test honest about having run.
  const asManifest: AgentModuleManifest<DemoToolContext> = demoModule;
  const backAgain: AgentModule<DemoToolContext> = asManifest;
  assert.equal(backAgain.name, 'demo');
});

test('the barrel ToolDef is the tool-server shape, not a contract sketch', () => {
  // `defineTool` is the live identity helper; if the barrel exported the v0
  // `ToolDef` instead, `readOnlyHint` would be an excess property and
  // `capabilityLine` would be missing, and neither this nor `parts` above
  // would compile.
  const asToolDef: ToolDef<Record<string, never>> = echoTool;
  assert.equal(asToolDef.readOnlyHint, true);
  assert.equal(asToolDef.minTier, 'member');
});

/**
 * The mechanical pin for #10. The two type sets could drift back apart the
 * moment someone re-adds a directory of aspirational interfaces and wires the
 * barrel to it — which is exactly how it happened the first time, and which no
 * amount of typechecking would catch, because a second `AgentModule` compiles
 * perfectly well on its own.
 */
test('the barrel re-exports nothing from a contract-only directory', () => {
  assert.ok(
    !existsSync(path.join(repoRoot, 'src/module-api')),
    'src/module-api/ held v0 sketches of seams whose runtime did not exist; a planned extension point ' +
      'belongs in docs/MODULE-API.md, which nobody can import',
  );
  const barrel = readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');
  const sources = [...barrel.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    sources.length > 10,
    `precondition: the barrel re-exports from several modules (${sources.length})`,
  );
  for (const source of sources) {
    assert.ok(
      existsSync(path.join(repoRoot, 'src', source.replace(/\.js$/, '.ts'))),
      `src/index.ts re-exports from ./${source}, which does not exist`,
    );
    assert.ok(
      !source.startsWith('module-api/'),
      `src/index.ts re-exports from ./${source} — the barrel exports live types only`,
    );
  }
});
