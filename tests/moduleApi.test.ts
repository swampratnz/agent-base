import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { AgentModule, ToolDef } from '../src/index.js';

// A minimal but representative module exercising the manifest surface. This
// is primarily a compile-time contract test: if the module API drifts in a
// way that breaks a plausible consumer, this file stops typechecking.
const echoTool: ToolDef<z.ZodObject<{ text: z.ZodString }>> = {
  name: 'echo',
  description: 'Echo the input back.',
  minTier: 'member',
  readOnly: true,
  capabilityLine: 'echo — repeats what you said (member+)',
  schema: z.object({ text: z.string().max(200) }),
  handler: async (args) => args.text,
};

const demoModule: AgentModule = {
  name: 'demo',
  configSchema: z.object({ DEMO_ENABLED: z.coerce.boolean().default(false) }),
  tools: [echoTool],
  jobs: [
    {
      name: 'demo-sweep',
      enabled: () => true,
      intervalMs: 60_000,
      runOnce: async () => {},
    },
  ],
  migrations: [
    {
      name: 'demo-core',
      sql: 'CREATE TABLE IF NOT EXISTS demo_items (id BIGSERIAL PRIMARY KEY);',
    },
  ],
  promptSections: { charter: 'You are the demo agent.' },
  strings: {
    languages: ['mi'],
    notices: { pause: { default: 'Paused.', mi: 'Kua okioki.' } },
  },
  auditActionKinds: ['demo_reset'],
};

// Narrowed once, so neither test needs a non-null assertion on the optional
// `tools` field (the manifest makes every extension point optional by design).
const demoTools = demoModule.tools ?? [];

test('a minimal module satisfies the manifest contract', async () => {
  assert.equal(demoModule.name, 'demo');
  assert.equal(demoModule.tools?.length, 1);
  const tool = demoTools[0];
  assert.equal(tool.minTier, 'member');
  const parsed = tool.schema.parse({ text: 'hello' });
  assert.deepEqual(parsed, { text: 'hello' });
});

test('tool schemas reject out-of-contract input', () => {
  const tool = demoTools[0];
  assert.throws(() => tool.schema.parse({ text: 'x'.repeat(500) }));
});
