import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure pins for the skills-allowlist enforcement point
// (src/agent/skillsManifest.ts) — a dependency-free leaf, no dummy env.
//
// The invariant this file owns is docs/SECURITY.md's "skills allowlists
// explicit, never a wildcard" (issue #741): the SDK's `skills: 'all'` would
// let a skill file dropped into the plugin directory self-activate without
// the deliberate second edit the hand-written allowlist requires. It was
// enforced at registration but pinned by no test in this repository.
//
// Order matters within this file: the fail-closed accessor is asserted while
// nothing is registered, then a valid registration runs, then the
// register-once rule is asserted against it. node:test runs a file's tests
// sequentially, and this file gets its own process.
import { registerSkillsManifest, skillsManifest, type SkillsManifest } from '../src/agent/skillsManifest.js';

test("SECURITY: the SDK 'all' wildcard is never accepted — not as the list, not as an entry", () => {
  // `skills: 'all'` handed in as the whole list (a non-array) …
  assert.throws(
    () => registerSkillsManifest({ skillsDir: '/skills', enabledSkills: 'all' } as unknown as SkillsManifest),
    /never accepted/,
  );
  // … and 'all' smuggled in as one entry of an otherwise-literal list.
  assert.throws(
    () => registerSkillsManifest({ skillsDir: '/skills', enabledSkills: ['review', 'all'] }),
    /never 'all'/,
  );
});

test('SECURITY: blank skill names and a blank skillsDir are rejected — a half-formed manifest can never register', () => {
  assert.throws(() => registerSkillsManifest({ skillsDir: '/skills', enabledSkills: ['review', ''] }));
  assert.throws(() => registerSkillsManifest({ skillsDir: '/skills', enabledSkills: ['  '] }));
  assert.throws(() => registerSkillsManifest({ skillsDir: '', enabledSkills: ['review'] }));
});

test('SECURITY: the accessor fails closed — an unregistered manifest throws rather than reading as an empty allowlist', () => {
  // Every rejected attempt above must have left the registry empty: an
  // accessor that returned [] here would silently mean "no skills" where the
  // truth is "no module ever registered".
  assert.throws(() => skillsManifest(), /no skills manifest registered/);
});

test('SECURITY: registration is once and the allowlist is frozen — the surface can never be widened after boot', () => {
  registerSkillsManifest({ skillsDir: '/skills', enabledSkills: ['review'] });
  const manifest = skillsManifest();
  assert.deepEqual([...manifest.enabledSkills], ['review']);
  assert.ok(Object.isFrozen(manifest.enabledSkills), 'the registered allowlist must be frozen');
  assert.throws(() => (manifest.enabledSkills as string[]).push('rogue-skill'));
  assert.throws(
    () => registerSkillsManifest({ skillsDir: '/other', enabledSkills: ['rogue-skill'] }),
    /already registered/,
  );
  assert.deepEqual([...skillsManifest().enabledSkills], ['review']);
});
