// The POSITIVE boot smoke: a minimal COMPLETE composition, booted from the
// installed package.
//
// Run inside a scaffolded repo that has `@swampratnz/agent-base` installed
// from a packed tarball. It is deliberately NOT part of the published package
// (`.github/` is outside `files`) and is copied in by the consumption
// workflow — it tests the package, so it must not be part of it.
//
// ## Why this exists
//
// `template/`'s own `main.ts` is the NEGATIVE case: it registers only
// `promptSections`, so `createAgent` refuses and names the eight gaps. That
// proves the fail-closed path, and the workflow asserts it. It cannot prove
// the happy path, because a scaffold that booted would be a scaffold with a
// finished agent in it.
//
// The happy path is the one that matters here. community-agent once shipped a
// commit whose built entry point threw on the first registration read — static
// imports are evaluated before the composition root's body runs — and 2,830
// passing tests did not notice, because the suite drove every registry
// directly and never once ran the composition in order. Only starting the
// program finds that. So: start the program.
//
// ## What "ready" means
//
// `createAgent` already owns the assertion. It plans, inits, registers, and
// then probes the real accessors; it returns nothing at all unless the surface
// is complete. `start()` runs the migrations and flips `started`. So reaching
// `agent.started === true` without throwing IS the ready signal — there is no
// need to invent a health check, and inventing one would test the wrong thing.
import { createAgent, BASE_NOTICE_IDS } from '@swampratnz/agent-base';

/**
 * A complete notice pack, generated rather than written out.
 *
 * `registerNoticePack` checks PRESENCE, not type — it rejects a pack missing
 * any id the base serves and says nothing about the values. Several ids are
 * function-typed (`codeTruncatedNote(shown)`, `blockedDm()`, …), but a boot
 * renders no notice, so plain strings register and boot correctly. Generating
 * from `BASE_NOTICE_IDS` also means this file cannot rot when the base adds an
 * id: the pack grows with it, and the day that stops being true is the day
 * `registerNoticePack` throws here and names the gap.
 */
const notices = {
  axes: { languages: [], styles: [] },
  entries: Object.fromEntries(BASE_NOTICE_IDS.map((id) => [id, { base: `smoke:${id}` }])),
};

/** The closed, all-required prompt slot set. Every field or registration throws. */
const promptSections = {
  charter: 'smoke',
  behaviourGuidelines: 'smoke',
  recallEtiquette: 'smoke',
  conductGuidance: 'smoke',
  promptReviewClause: 'smoke',
  webSearchAuthority: 'smoke',
  dateLine: () => '- Date: smoke',
  responseStyleSections: {},
  languagePreferenceSections: {},
};

/** Every registration `createAgent` requires, and nothing more. */
const smokeModule = {
  name: 'smoke',
  notices,
  toolTiers: { member: [], admin: [], superAdmin: [], discordOnly: [] },
  toolServerParts: {
    name: 'smoke',
    makeContext: (caller) => ({ callerId: caller.userId }),
    registry: [],
  },
  flaggedToolPredicates: [],
  skills: { skillsDir: '/nonexistent', enabledSkills: [] },
  promptSections,
  commands: [],
  defaultBadWords: ['smokeword'],
  personas: [{ persona: { id: 'smoke', name: 'Smoke', voice: 'plain', aliases: [] }, isDefault: true }],
};

const agent = await createAgent({ modules: [smokeModule] });

// `start()` runs the migrations (base fragments first) and then the callback.
// No callback: bringing adapters up would need real platform credentials, and
// the composition is what is under test, not Discord's API.
await agent.start();

if (agent.started !== true) {
  console.error('SMOKE FAIL: start() resolved but agent.started is not true');
  process.exit(1);
}

console.log('SMOKE OK: composition complete, migrations applied, agent started');

// Nothing is listening, but the pg pool holds the event loop open. The boot is
// what was under test and it succeeded, so say so and leave deliberately.
process.exit(0);
