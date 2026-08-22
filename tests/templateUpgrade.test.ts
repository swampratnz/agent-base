import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/upgrade-template.mjs — the three-way template upgrade.
 *
 * The three states per file are: the hash recorded at scaffold time
 * (template.manifest.json, copied into the scaffold), the current template,
 * and the scaffold's on-disk file. These tests pin every branch: clean
 * overwrite, already-current, local-only edits left alone, real conflicts
 * marked for a human, upstream additions landing in directories that do not
 * exist yet (the exact bug the reviewed upstream implementation had), rej
 * mode, dry-run writing nothing, and the baseline reset afterward.
 */

const UPGRADE = fileURLToPath(new URL('../scripts/upgrade-template.mjs', import.meta.url));
const CHECK = fileURLToPath(new URL('../scripts/check-template-manifest.mjs', import.meta.url));

function runUpgrade(args: string[]) {
  const res = spawnSync(process.execPath, [UPGRADE, ...args], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/**
 * A fixture pair: an "old" template scaffolded into a consumer dir (with its
 * manifest, as a real scaffold copy carries), then the template evolved.
 */
function fixture(): { root: string; template: string; scaffold: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'template-upgrade-'));
  const template = path.join(root, 'template');
  const scaffold = path.join(root, 'app');
  const write = (base: string, rel: string, content: string) => {
    const abs = path.join(base, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write(template, 'untouched.ts', 'v1\n');
  write(template, 'edited-by-consumer.ts', 'v1\n');
  write(template, 'both-changed.ts', 'v1\n');
  write(template, 'removed-later.ts', 'v1\n');
  // Record the generation-time manifest, then scaffold = copy (manifest included).
  spawnSync(process.execPath, [CHECK, '--root', root, '--write'], { encoding: 'utf8' });
  cpSync(template, scaffold, { recursive: true });
  // The consumer edits two files…
  write(scaffold, 'edited-by-consumer.ts', 'consumer version\n');
  write(scaffold, 'both-changed.ts', 'consumer version\n');
  // …and the template moves on: one clean fix, one overlapping change, one
  // addition in a brand-new directory, one removal.
  write(template, 'untouched.ts', 'v2\n');
  write(template, 'both-changed.ts', 'v2\n');
  write(template, 'new-dir/added.ts', 'brand new\n');
  rmSync(path.join(template, 'removed-later.ts'));
  return { root, template, scaffold, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('clean updates overwrite, local-only edits stay, conflicts get inline markers, additions mkdir', () => {
  const f = fixture();
  try {
    const res = runUpgrade(['--scaffold', f.scaffold, '--template', f.template]);
    assert.equal(res.status, 1, res.out); // conflicts exist -> a human is needed
    // Clean overwrite: consumer never touched it.
    assert.equal(readFileSync(path.join(f.scaffold, 'untouched.ts'), 'utf8'), 'v2\n');
    // Local-only edit with no upstream change: left exactly as the consumer had it.
    assert.equal(readFileSync(path.join(f.scaffold, 'edited-by-consumer.ts'), 'utf8'), 'consumer version\n');
    // Real conflict: both halves present between markers.
    const conflicted = readFileSync(path.join(f.scaffold, 'both-changed.ts'), 'utf8');
    assert.match(conflicted, /<<<<<<< scaffold/);
    assert.match(conflicted, /consumer version/);
    assert.match(conflicted, /v2/);
    assert.match(conflicted, />>>>>>> template/);
    // Upstream addition in a directory the scaffold does not have: created.
    assert.equal(readFileSync(path.join(f.scaffold, 'new-dir', 'added.ts'), 'utf8'), 'brand new\n');
    // Removed upstream: reported, left in place.
    assert.match(res.out, /removed upstream/);
    assert.ok(existsSync(path.join(f.scaffold, 'removed-later.ts')));
    // Baseline reset: a second run finds only the unresolved conflict.
    const again = runUpgrade(['--scaffold', f.scaffold, '--template', f.template]);
    assert.doesNotMatch(again.out, /update \(clean overwrite\):/);
  } finally {
    f.cleanup();
  }
});

test('--conflict rej leaves the local file intact and writes the upstream half beside it', () => {
  const f = fixture();
  try {
    const res = runUpgrade(['--scaffold', f.scaffold, '--template', f.template, '--conflict', 'rej']);
    assert.equal(res.status, 1);
    assert.equal(readFileSync(path.join(f.scaffold, 'both-changed.ts'), 'utf8'), 'consumer version\n');
    assert.equal(readFileSync(path.join(f.scaffold, 'both-changed.ts.rej'), 'utf8'), 'v2\n');
  } finally {
    f.cleanup();
  }
});

test('--dry-run prints the plan and writes nothing', () => {
  const f = fixture();
  try {
    const res = runUpgrade(['--scaffold', f.scaffold, '--template', f.template, '--dry-run']);
    assert.equal(res.status, 1); // conflicts are still the verdict
    assert.match(res.out, /dry run/);
    assert.equal(readFileSync(path.join(f.scaffold, 'untouched.ts'), 'utf8'), 'v1\n');
    assert.equal(existsSync(path.join(f.scaffold, 'new-dir')), false);
  } finally {
    f.cleanup();
  }
});

test('a scaffold without the recorded manifest is refused with the remedy, never guessed at', () => {
  const f = fixture();
  try {
    rmSync(path.join(f.scaffold, 'template.manifest.json'));
    const res = runUpgrade(['--scaffold', f.scaffold, '--template', f.template]);
    assert.equal(res.status, 1);
    assert.match(res.out, /predates the manifest/);
    // Nothing was touched.
    assert.equal(readFileSync(path.join(f.scaffold, 'untouched.ts'), 'utf8'), 'v1\n');
  } finally {
    f.cleanup();
  }
});
