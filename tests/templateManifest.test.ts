import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/check-template-manifest.mjs — the integrity gate on template/.
 *
 * template/ sits outside every other gate by design (CLAUDE.md, scope notes),
 * so this manifest is the one mechanical thing standing between a stray edit
 * and the next scaffold silently inheriting it. These tests drive the gate
 * against fixture trees (via `--root`) so each failure mode is pinned, plus
 * one test against the real repo so the committed manifest can never drift
 * from the committed template.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/check-template-manifest.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(args: string[], cwd?: string) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** A fixture repo with a template/ tree. */
function fixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'template-manifest-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, 'template', rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('--write creates a sorted schema-1 manifest and the check then passes', () => {
  const { root, cleanup } = fixture({ 'b.ts': 'export {};\n', 'a/deep.md': '# hi\n' });
  try {
    assert.equal(run(['--root', root, '--write']).status, 0);
    const manifest = JSON.parse(readFileSync(path.join(root, 'template', 'template.manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 1);
    assert.deepEqual(Object.keys(manifest.files), ['a/deep.md', 'b.ts']);
    const check = run(['--root', root]);
    assert.equal(check.status, 0, check.out);
    assert.match(check.out, /OK — 2 files/);
  } finally {
    cleanup();
  }
});

test('an edited file fails the check by name, with the remedy', () => {
  const { root, cleanup } = fixture({ 'a.ts': 'one\n' });
  try {
    run(['--root', root, '--write']);
    writeFileSync(path.join(root, 'template', 'a.ts'), 'two\n');
    const check = run(['--root', root]);
    assert.equal(check.status, 1);
    assert.match(check.out, /changed: a\.ts/);
    assert.match(check.out, /template:fix/);
  } finally {
    cleanup();
  }
});

test('added and removed files fail the check by name', () => {
  const { root, cleanup } = fixture({ 'keep.ts': 'k\n', 'gone.ts': 'g\n' });
  try {
    run(['--root', root, '--write']);
    unlinkSync(path.join(root, 'template', 'gone.ts'));
    writeFileSync(path.join(root, 'template', 'fresh.ts'), 'f\n');
    const check = run(['--root', root]);
    assert.equal(check.status, 1);
    assert.match(check.out, /added: {3}fresh\.ts/);
    assert.match(check.out, /removed: gone\.ts/);
  } finally {
    cleanup();
  }
});

test('a missing manifest fails with the remedy, not a crash', () => {
  const { root, cleanup } = fixture({ 'a.ts': 'x\n' });
  try {
    const check = run(['--root', root]);
    assert.equal(check.status, 1);
    assert.match(check.out, /missing/);
    assert.match(check.out, /template:fix/);
  } finally {
    cleanup();
  }
});

test('CRLF and LF checkouts of identical content hash the same (EOLs are not drift)', () => {
  const { root, cleanup } = fixture({ 'a.ts': 'line one\nline two\n' });
  try {
    run(['--root', root, '--write']);
    writeFileSync(path.join(root, 'template', 'a.ts'), 'line one\r\nline two\r\n');
    const check = run(['--root', root]);
    assert.equal(check.status, 0, check.out);
  } finally {
    cleanup();
  }
});

test('the committed manifest matches the real template/ (regenerate with npm run template:fix)', () => {
  const check = run(['--root', REPO_ROOT]);
  assert.equal(
    check.status,
    0,
    `template/ drifted from template/template.manifest.json — a template edit must be deliberate:\n${check.out}`,
  );
});
