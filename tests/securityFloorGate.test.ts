import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Coverage for `scripts/check-security-test-count.mjs` and its `--write`
// helper (`npm run test:security:fix`), the command the pipeline's autofix /
// conflict-resolver loops use to heal a per-file security-floor.json count
// mismatch autonomously. The whole point of that helper's safety rail is that
// it can RAISE/ADD counts but must never silently LOWER or drop one — which
// would paper over a deleted SECURITY: test, the exact regression the gate
// exists to catch. That invariant is security-relevant, so it is pinned here
// (SECURITY:-prefixed) rather than checked by hand.
//
// Ported from community-agent with its semantics unchanged, plus coverage for
// what this copy generalises: the `--tests-dir` / `--manifest` / `--root`
// flags that replace its hardcoded `tests/` path, and the empty-manifest state
// that a freshly-scaffolded repo starts in.
//
// Each case runs the REAL script (copied into a throwaway repo-shaped tree so
// its `dirname/..` path resolution lands on the temp dir) against fixture test
// files + manifest, exercising the actual code path, not a reimplementation.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realScript = path.join(repoRoot, 'scripts', 'check-security-test-count.mjs');

// Build fixture test-file CONTENT declaring `n` SECURITY: tests. The quote is
// interpolated so THIS file's own source reads `test(${Q}SECURITY:` — `test(`
// followed by `$`, which the gate's own static scanner does NOT match — while
// the WRITTEN fixture file gets a literal SECURITY:-prefixed declaration the
// scanner counts. (Without this trick these fixtures would inflate this file's
// declared SECURITY: count and break the floor.)
const Q = "'";
function fixtureContent(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += `test(${Q}SECURITY: case ${i}${Q}, () => undefined);\n`;
  return out;
}

/** A repo-shaped temp tree: the real script, some fixture test files, a manifest. */
function setup(files: Record<string, number>, manifest: Record<string, number>, testsDir = 'tests'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'secfloor-'));
  mkdirSync(path.join(dir, 'scripts'));
  mkdirSync(path.join(dir, testsDir), { recursive: true });
  copyFileSync(realScript, path.join(dir, 'scripts', 'check-security-test-count.mjs'));
  for (const [name, n] of Object.entries(files)) {
    writeFileSync(path.join(dir, testsDir, name), fixtureContent(n));
  }
  writeFileSync(path.join(dir, testsDir, 'security-floor.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

function run(dir: string, extraArgs: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('node', [path.join(dir, 'scripts', 'check-security-test-count.mjs'), ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runWrite(dir: string, extraArgs: string[] = []) {
  return run(dir, ['--write', ...extraArgs]);
}

function readManifest(dir: string, rel = 'tests/security-floor.json'): Record<string, number> {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as Record<string, number>;
}

test('SECURITY: test:security:fix raises a lagging per-file count and normalises key order to sorted', () => {
  // Deliberately non-alphabetical manifest order; zeta under-counts reality.
  const dir = setup({ 'zeta.test.ts': 3, 'alpha.test.ts': 2 }, { 'zeta.test.ts': 1, 'alpha.test.ts': 2 });
  try {
    const res = runWrite(dir);
    assert.equal(res.status, 0, res.stderr);
    const m = readManifest(dir);
    assert.deepEqual(
      Object.keys(m),
      ['alpha.test.ts', 'zeta.test.ts'],
      're-sorted to alphabetical order (sorted order keeps concurrent PRs from conflicting here)',
    );
    assert.equal(m['zeta.test.ts'], 3, 'lagging count raised to the true count');
    assert.equal(m['alpha.test.ts'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix places every entry (existing + newly-covered) in sorted position', () => {
  // 'omega' already in the manifest is NOT alphabetically first, so a correct
  // sort must MOVE it after the newly-covered 'alpha'/'beta' — proving the
  // output is fully sorted, not merely "new files appended at the end".
  const dir = setup({ 'omega.test.ts': 1, 'alpha.test.ts': 2, 'beta.test.ts': 1 }, { 'omega.test.ts': 1 });
  try {
    const res = runWrite(dir);
    assert.equal(res.status, 0, res.stderr);
    const m = readManifest(dir);
    assert.deepEqual(Object.keys(m), ['alpha.test.ts', 'beta.test.ts', 'omega.test.ts']);
    assert.equal(m['alpha.test.ts'], 2);
    assert.equal(m['beta.test.ts'], 1);
    assert.equal(m['omega.test.ts'], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test:security (check mode) fails on an unsorted manifest and points at the --fix command', () => {
  // Counts MATCH reality, so the ONLY problem is key order — the check must
  // still fail (that is what keeps the anti-conflict sorted invariant honest).
  const dir = setup({ 'alpha.test.ts': 1, 'zeta.test.ts': 1 }, { 'zeta.test.ts': 1, 'alpha.test.ts': 1 });
  try {
    const res = run(dir);
    assert.notEqual(res.status, 0, 'an out-of-order manifest must fail the check');
    assert.match(res.stderr, /not sorted/i);
    assert.match(res.stderr, /test:security:fix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix refuses to LOWER a count without --allow-lower (cannot mask a deleted security test)', () => {
  const dir = setup({ 'alpha.test.ts': 2 }, { 'alpha.test.ts': 5 });
  try {
    const res = runWrite(dir);
    assert.notEqual(res.status, 0, 'must exit non-zero when a count would drop');
    assert.match(res.stderr, /refusing to LOWER/i);
    assert.equal(readManifest(dir)['alpha.test.ts'], 5, 'manifest left UNCHANGED on refusal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix lowers a count only when --allow-lower is explicitly passed', () => {
  const dir = setup({ 'alpha.test.ts': 2 }, { 'alpha.test.ts': 5 });
  try {
    const res = runWrite(dir, ['--allow-lower']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readManifest(dir)['alpha.test.ts'],
      2,
      'count lowered to reality only with the explicit flag',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: test:security:fix refuses to DROP a removed file’s entry without --allow-lower', () => {
  // The manifest lists a file that no longer exists under tests/.
  const dir = setup({ 'alpha.test.ts': 1 }, { 'alpha.test.ts': 1, 'removed.test.ts': 3 });
  try {
    const res = runWrite(dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing to LOWER/i);
    assert.ok('removed.test.ts' in readManifest(dir), 'entry for a missing file is NOT silently dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: check mode refuses a per-file count LOWERED vs the PR base unless the override is set', () => {
  // Baseline: alpha declares 3 SECURITY tests, manifest agrees (consistent, green).
  const dir = setup({ 'alpha.test.ts': 3 }, { 'alpha.test.ts': 3 });
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'ci@example.com']);
    git(['config', 'user.name', 'CI']);
    git(['add', '.']);
    git(['commit', '-q', '--no-gpg-sign', '-m', 'baseline']);

    // A PR deletes ONE SECURITY test AND lowers the manifest to match: 2 == 2,
    // so the plain exact-match check alone stays green — this is exactly the
    // silent regression the baseline guard exists for.
    writeFileSync(path.join(dir, 'tests', 'alpha.test.ts'), fixtureContent(2));
    writeFileSync(
      path.join(dir, 'tests', 'security-floor.json'),
      JSON.stringify({ 'alpha.test.ts': 2 }, null, 2) + '\n',
    );

    const blocked = run(dir, [], { SECURITY_FLOOR_BASELINE_REF: 'HEAD' });
    assert.notEqual(blocked.status, 0, 'a silent lowering vs the base must fail the check');
    assert.match(blocked.stderr, /LOWERED 3 . 2/, 'names the file and the base→now drop');
    assert.match(blocked.stderr, /allow-security-floor-lower/, 'points at the explicit override');

    const overridden = run(dir, [], {
      SECURITY_FLOOR_BASELINE_REF: 'HEAD',
      ALLOW_SECURITY_FLOOR_LOWER: 'true',
    });
    assert.doesNotMatch(
      overridden.stderr ?? '',
      /LOWERED/,
      'the explicit allow-security-floor-lower override suppresses the lowering block',
    );

    const noBaseline = run(dir, [], { SECURITY_FLOOR_BASELINE_REF: '' });
    assert.doesNotMatch(
      noBaseline.stderr ?? '',
      /LOWERED/,
      'with no base ref (local/push/merge_group) the guard is inactive — unchanged behaviour',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: check mode catches a RENAME-with-drop via the global-sum backstop', () => {
  // Baseline: alpha declares 3 SECURITY tests, manifest agrees.
  const dir = setup({ 'alpha.test.ts': 3 }, { 'alpha.test.ts': 3 });
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'ci@example.com']);
    git(['config', 'user.name', 'CI']);
    git(['add', '.']);
    git(['commit', '-q', '--no-gpg-sign', '-m', 'baseline']);

    // Rename alpha.test.ts → zeta.test.ts AND drop one test (3 → 2), with a
    // matching zeta:2 manifest entry. The exact-match check passes (2==2 for
    // the new name) and the per-file baseline check sees alpha vanish as a
    // legit deletion — only the global-sum backstop (3 → 2) catches it.
    rmSync(path.join(dir, 'tests', 'alpha.test.ts'));
    writeFileSync(path.join(dir, 'tests', 'zeta.test.ts'), fixtureContent(2));
    writeFileSync(
      path.join(dir, 'tests', 'security-floor.json'),
      JSON.stringify({ 'zeta.test.ts': 2 }, null, 2) + '\n',
    );

    const blocked = run(dir, [], { SECURITY_FLOOR_BASELINE_REF: 'HEAD' });
    assert.notEqual(blocked.status, 0, 'a rename-with-drop must fail the check');
    assert.match(
      blocked.stderr,
      /total SECURITY: test count DROPPED 3 . 2/,
      'the net-drop backstop names it',
    );
    assert.match(blocked.stderr, /allow-security-floor-lower/);

    const overridden = run(dir, [], {
      SECURITY_FLOOR_BASELINE_REF: 'HEAD',
      ALLOW_SECURITY_FLOOR_LOWER: 'true',
    });
    assert.doesNotMatch(
      overridden.stderr ?? '',
      /DROPPED/,
      'the explicit override suppresses the net-drop block',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: an unconditional test.skip( of a SECURITY test is refused, keeping its count honest', () => {
  const dir = setup({ 'alpha.test.ts': 0 }, { 'alpha.test.ts': 1 });
  try {
    writeFileSync(
      path.join(dir, 'tests', 'alpha.test.ts'),
      `test.skip(${Q}SECURITY: disabled${Q}, () => {});\n`,
    );
    const res = run(dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unconditional skip\/todo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- What this copy generalises ---------------------------------------------

test('an empty manifest is a valid starting state, not a failure', () => {
  // Every freshly-scaffolded agent (and this repo, until the runtime is
  // extracted) starts with zero SECURITY: tests. The gate must pass and say so
  // rather than spawn a runner whose name pattern matches nothing.
  const dir = setup({}, {});
  try {
    const res = run(dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no SECURITY: tests declared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--tests-dir relocates the scan and --manifest relocates the floor', () => {
  const dir = setup({ 'alpha.test.ts': 2 }, { 'alpha.test.ts': 1 }, 'packages/core/tests');
  try {
    const args = [
      '--tests-dir',
      'packages/core/tests',
      '--manifest',
      'packages/core/tests/security-floor.json',
    ];
    const failed = run(dir, args);
    assert.notEqual(failed.status, 0, 'the lagging count must still be caught under a relocated root');
    assert.match(failed.stderr, /packages\/core\/tests\/security-floor\.json/);

    assert.equal(runWrite(dir, args).status, 0);
    assert.equal(readManifest(dir, 'packages/core/tests/security-floor.json')['alpha.test.ts'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with several --tests-dir roots the manifest is keyed by repo-relative path', () => {
  // Bare file names stop being unique across roots, so the key convention
  // switches — and the failure message says which convention is in force.
  const dir = setup({ 'alpha.test.ts': 1 }, {}, 'packages/core/tests');
  try {
    mkdirSync(path.join(dir, 'packages/module/tests'), { recursive: true });
    writeFileSync(path.join(dir, 'packages/module/tests/alpha.test.ts'), fixtureContent(2));
    const args = [
      '--tests-dir',
      'packages/core/tests',
      '--tests-dir',
      'packages/module/tests',
      '--manifest',
      'packages/core/tests/security-floor.json',
    ];
    const res = run(dir, args);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /repo-relative paths/);

    assert.equal(runWrite(dir, args).status, 0);
    assert.deepEqual(readManifest(dir, 'packages/core/tests/security-floor.json'), {
      'packages/core/tests/alpha.test.ts': 1,
      'packages/module/tests/alpha.test.ts': 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing manifest fails with an actionable message rather than a stack trace', () => {
  const dir = setup({ 'alpha.test.ts': 1 }, {});
  try {
    rmSync(path.join(dir, 'tests', 'security-floor.json'));
    const res = run(dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no manifest at tests\/security-floor\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real tests/security-floor.json matches this repo', () => {
  // Belt and braces: CI runs `npm run test:security` in its own job, but a
  // contributor running only `npm test` should still see a lagging manifest.
  //
  // The child must NOT inherit NODE_TEST_CONTEXT: the gate spawns a node:test
  // runner of its own, and node refuses to run test FILES recursively inside
  // an already-running test process ("run() is being called recursively"),
  // which would report zero SECURITY tests and fail for a reason that has
  // nothing to do with the manifest.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync('node', [realScript], { cwd: repoRoot, encoding: 'utf8', env });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
});

test("template/'s empty security floor is a valid starting state", () => {
  // template/ sits outside every other gate's scope, so this is the only
  // check that would notice its ratchet files rotting — e.g. someone deleting
  // the empty manifest a scaffolded repo is supposed to start from.
  const res = spawnSync('node', [realScript, '--root', path.join(repoRoot, 'template')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /no SECURITY: tests declared/);
});
