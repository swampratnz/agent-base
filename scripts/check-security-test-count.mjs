#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Runs every SECURITY:-prefixed test (see CLAUDE.md) and enforces a count
// floor: `npm run test:security` fails not just on a failing assertion but
// also if fewer SECURITY tests exist than expected. That turns "someone
// deleted or silently disabled a security test" from a still-green CI run
// into a loud failure.
//
// The expected counts live in a manifest (by default
// `tests/security-floor.json`) as a PER-FILE map (file → number of SECURITY:
// tests declared in it), not a single global constant. A global
// `MIN_SECURITY_TESTS = N` constant was community-agent's #1 merge-conflict
// hotspot: every PR that added a SECURITY test edited the same line, so any
// two in-flight PRs conflicted with each other. Per-file entries mean
// concurrent PRs only conflict when they touch the SAME test file — which is
// a conflict worth having. The manifest is additionally kept SORTED by key
// (enforced below, normalised by --write) so that two PRs adding entries for
// DIFFERENT new files don't collide at a shared append point either — see the
// --write section for the full rationale.
//
// Convention: when you add a SECURITY: test, bump that file's entry in the
// manifest in the SAME diff (add the entry if the file is new). The check is
// exact, not a floor, so the manifest can never silently lag reality in
// either direction. A diff that LOWERS an entry needs an explanation in the
// PR.
//
// Skipped tests (e.g. DB-backed cases when no DATABASE_URL is reachable) are
// reported by the Node test runner as `ok ... # SKIP ...`, so they still count
// toward the runtime check. That keeps the count stable across runners
// regardless of DB availability, while still catching an outright deletion of
// a DB-dependent security test.
//
// This pins the invariants that already have a SECURITY: test — it is not
// proof of total security coverage.
//
// ---------------------------------------------------------------------------
// Portability (what this copy generalises vs community-agent's)
// ---------------------------------------------------------------------------
// community-agent's copy hardcodes a single `tests/` directory at the repo
// root. This copy keeps the semantics EXACTLY and parameterises the paths, so
// one script serves this repo, a workspace layout, and every agent built from
// `template/`:
//
//   --root <dir>          repo root (default: this script's parent directory).
//                         Relocates everything below; lets the gate's own
//                         tests drive it against fixture trees. A repo that
//                         CONSUMES this package must pass `--root .`, because
//                         the default resolves inside node_modules.
//   --tests-dir <dir>     a test root, repo-relative. Repeatable. Default:
//                         `tests`.
//   --manifest <path>     manifest location, repo-relative. Default:
//                         `<first --tests-dir>/security-floor.json`.
//
// MANIFEST KEYS follow the number of test roots: with exactly one root they
// are bare file names (`rbac.test.ts`), byte-compatible with community-agent's
// existing manifest so it migrates unchanged; with more than one root they are
// repo-relative POSIX paths (`packages/core/tests/rbac.test.ts`), because bare
// names stop being unique. The check reports which convention is in force
// whenever it fails, and `--write` emits the right one.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---- Argument parsing ------------------------------------------------------
const argv = process.argv.slice(2);

function flagValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}

const repoRoot = flagValues('--root').at(-1)
  ? path.resolve(flagValues('--root').at(-1))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const testsDirsRel = flagValues('--tests-dir');
if (testsDirsRel.length === 0) testsDirsRel.push('tests');

const manifestRel =
  flagValues('--manifest').at(-1) ?? path.posix.join(testsDirsRel[0], 'security-floor.json');
const manifestPath = path.join(repoRoot, manifestRel);

/** With one test root, keys are bare file names; with several, repo-relative paths. */
const keyByPath = testsDirsRel.length > 1;
const keyConvention = keyByPath
  ? `repo-relative paths (multiple --tests-dir roots: ${testsDirsRel.join(', ')})`
  : 'bare file names';

if (!existsSync(manifestPath)) {
  console.error(
    `check-security-test-count: no manifest at ${manifestRel}. Create it with \`{}\` (an empty ` +
      `manifest is the correct state for a repo with no SECURITY: tests yet) or point at it with --manifest.`,
  );
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ---- Discover test files across every configured root ----------------------
/** @type {{ key: string, abs: string, rel: string }[]} */
const testFiles = [];
for (const dirRel of testsDirsRel) {
  const abs = path.join(repoRoot, dirRel);
  if (!existsSync(abs)) {
    console.error(`check-security-test-count: --tests-dir ${dirRel} does not exist under ${repoRoot}.`);
    process.exit(1);
  }
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.test.ts')) continue;
    const rel = path.posix.join(dirRel, name);
    testFiles.push({ key: keyByPath ? rel : name, abs: path.join(abs, name), rel });
  }
}
const testFileKeys = testFiles.map((f) => f.key);

// ---- Static check: per-file declaration counts must match the manifest ----
// Matches `test('SECURITY: …'`, `test("…`, `test(\`…`, and `test.skip(…` /
// `test.only(…` forms, including names wrapped onto the next line by
// prettier. Test names are static string literals by convention, so a static
// scan and the runtime count agree; if you ever build a SECURITY: test name
// dynamically, don't — the gate (and grep-ability) depend on literal names.
const declPattern = /\btest(?:\.[a-z]+)?\(\s*[`'"]SECURITY:/g;
const staticCounts = {};
for (const f of testFiles) {
  const n = (readFileSync(f.abs, 'utf8').match(declPattern) ?? []).length;
  if (n > 0) staticCounts[f.key] = n;
}

// ---- Optional: regenerate the manifest from the true static counts ---------
// `--write` turns a per-file floor mismatch into a mechanical, one-command fix
// (`npm run test:security:fix`). The pipeline's autofix and conflict-resolver
// loops use it after a merge brings in another in-flight PR's SECURITY: tests
// on the SAME file — the #1 source of "counts lag reality" escalations, which
// are not a real defect and should never reach a human.
//
// Output is fully SORTED by key, and the non-write check below ENFORCES that
// order. This is deliberately the opposite of "preserve insertion order,
// append new files at the end", and it is the whole reason this manifest
// stopped being a merge-conflict hotspot: appending each new file's entry at
// the end made every PR that covered a NEW test file edit the same final
// lines, so two such PRs conflicted even though their entries are
// independent. A manifest that is born sorted and kept sorted gives every
// entry a stable alphabetical home, so two PRs adding DIFFERENT files land in
// different hunks and git 3-way-merges them with no conflict for a human (or
// the resolver) to touch.
//
// Safety rail: it RAISES or ADDS entries freely, but REFUSES to lower or drop
// one (which would silently paper over a deleted/renamed-away security test —
// the exact regression this gate exists to catch) unless `--allow-lower` is
// also passed, which a PR must then explain. So the loops can heal the common
// "tests added, manifest lagging" case autonomously, but a genuine removal
// still stops for a human.
if (argv.includes('--write')) {
  const allowLower = argv.includes('--allow-lower');
  const lowered = [];
  const next = {};
  // Union of files already in the manifest and files with a live static count,
  // emitted in sorted order (see header): deterministic and conflict-resistant.
  const allFiles = [...new Set([...Object.keys(manifest), ...Object.keys(staticCounts)])].sort();
  for (const file of allFiles) {
    const actual = staticCounts[file] ?? 0;
    const expected = manifest[file]; // undefined for a newly-covered file
    if (expected !== undefined && actual === 0) {
      lowered.push(`${file}: ${expected} → 0 (entry would be removed)`);
      continue; // file deleted or all its SECURITY: tests gone — drop the entry
    }
    if (expected !== undefined && actual < expected) lowered.push(`${file}: ${expected} → ${actual}`);
    next[file] = actual;
  }
  if (lowered.length > 0 && !allowLower) {
    console.error(
      'check-security-test-count --write: refusing to LOWER or remove a per-file count — a SECURITY: ' +
        'test was deleted or renamed out of the namespace:',
    );
    for (const l of lowered) console.error(`  ${l}`);
    console.error('If this is intentional, re-run with --allow-lower and explain the removal in the PR.');
    process.exit(1);
  }
  const changed = JSON.stringify(manifest) !== JSON.stringify(next);
  if (changed) writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
  const total = Object.values(next).reduce((a, b) => a + b, 0);
  console.log(
    changed
      ? `check-security-test-count --write: regenerated ${manifestRel} (${Object.keys(next).length} files, ${total} SECURITY: tests).`
      : 'check-security-test-count --write: manifest already matches the code — no change.',
  );
  process.exit(0);
}

const problems = [];
for (const [file, expected] of Object.entries(manifest)) {
  const actual = staticCounts[file] ?? 0;
  if (actual < expected) {
    problems.push(
      `${file}: ${actual} SECURITY: test(s) declared, manifest expects ${expected}. A security test was ` +
        `deleted or renamed out of the SECURITY: namespace. If intentional, lower this file's entry in ` +
        `${manifestRel} and explain why in the PR.`,
    );
  } else if (actual > expected) {
    problems.push(
      `${file}: ${actual} SECURITY: test(s) declared, manifest expects ${expected}. You added a SECURITY: ` +
        `test — bump this file's entry in ${manifestRel} in the same diff ` +
        `(or run \`npm run test:security:fix\` to regenerate the manifest).`,
    );
  }
}
for (const [file, actual] of Object.entries(staticCounts)) {
  if (!(file in manifest)) {
    problems.push(
      `${file}: declares ${actual} SECURITY: test(s) but has no entry in ${manifestRel} — ` +
        `add one in the same diff, in sorted position. Keys in this repo are ${keyConvention}.`,
    );
  }
}

// The manifest must stay SORTED by key. A sorted manifest is exactly what lets
// two PRs that each add an entry for a DIFFERENT test file merge without
// conflicting here (their entries live in different hunks); an out-of-order
// entry silently erodes that property one PR at a time. This is a mechanical,
// --write-fixable ordering nit rather than a security finding, but it is
// cheapest to enforce right where the counts are already validated.
const manifestKeys = Object.keys(manifest);
const sortedKeys = [...manifestKeys].sort();
if (manifestKeys.some((k, i) => k !== sortedKeys[i])) {
  const firstOff = manifestKeys.findIndex((k, i) => k !== sortedKeys[i]);
  problems.push(
    `${manifestRel} is not sorted by file name (first out-of-order entry: ` +
      `${manifestKeys[firstOff]}). A sorted manifest lets PRs that add different test files merge ` +
      `without conflicting on this manifest — run \`npm run test:security:fix\` to normalise the order.`,
  );
}

// Unconditional skip/todo of a SECURITY test evades the gate:
// `test.skip(`/`test.todo(` keep the static count (declPattern matches them)
// while removing the assertion, and node reports the skip as `ok … # SKIP`
// which the runtime pass-counter below would otherwise credit. Ban the
// METHOD forms outright — a genuine environment gate (e.g. DB-unavailable)
// uses the OPTION form instead: `test('SECURITY: …', { skip }, fn)`, which is
// not matched here and stays allowed.
const bannedSkipPattern = /\btest\.(?:skip|todo)\(\s*[`'"]SECURITY:/g;
for (const f of testFiles) {
  const n = (readFileSync(f.abs, 'utf8').match(bannedSkipPattern) ?? []).length;
  if (n > 0) {
    problems.push(
      `${f.key}: ${n} SECURITY: test(s) use test.skip(/test.todo( — an unconditional skip/todo disables a security ` +
        `test while keeping its count. Restore the assertion, or (only for a real environment gate) use the ` +
        `conditional option form test('SECURITY: …', { skip: <cond> }, fn).`,
    );
  }
}

// ---- CI-only: refuse a SILENT LOWERING of the manifest vs the PR base ------
// The exact-match check above is satisfied by a PR that DELETES a SECURITY:
// test AND lowers that file's manifest entry in the same diff (actual ==
// expected → green). That is the one way this gate can be neutered without a
// loud failure. When a base ref is provided (CI sets
// SECURITY_FLOOR_BASELINE_REF on pull_request; unset on local/push/merge_group
// runs, which are then unaffected), compare each per-file count against the
// base manifest and FAIL on any decrease — or an entry removed while its test
// file still exists — unless ALLOW_SECURITY_FLOOR_LOWER is set. That override
// is wired from an explicit 'allow-security-floor-lower' PR label, so a
// genuine removal still stops for a human to consciously apply the label and
// explain it, mirroring the `--write --allow-lower` guard.
const baselineRef = process.env.SECURITY_FLOOR_BASELINE_REF?.trim();
if (baselineRef && process.env.ALLOW_SECURITY_FLOOR_LOWER !== 'true') {
  const show = spawnSync('git', ['show', `${baselineRef}:${manifestRel}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (show.status === 0) {
    const baseline = (() => {
      try {
        return JSON.parse(show.stdout);
      } catch {
        return null;
      }
    })();
    if (baseline && typeof baseline === 'object') {
      for (const [file, baseCount] of Object.entries(baseline)) {
        const nowCount = manifest[file] ?? 0;
        // Per-file check: precise message for the common straight-lowering
        // case. A whole test FILE genuinely gone is a legitimate removal, so
        // only flag a count that dropped while the test file still exists (or
        // an entry silently zeroed for a live file). This alone MISSES a
        // rename-with-drop (old key vanishes, new key isn't in the baseline) —
        // the global-sum check below is the rename-proof backstop.
        const fileStillExists = testFileKeys.includes(file);
        if (nowCount < baseCount && (fileStillExists || nowCount > 0)) {
          problems.push(
            `${file}: security-floor entry LOWERED ${baseCount} → ${nowCount} vs the PR base — a SECURITY: ` +
              `test was removed. Refused by default. If the removal is intentional, add the ` +
              `'allow-security-floor-lower' label (which sets ALLOW_SECURITY_FLOOR_LOWER) and explain it in the PR.`,
          );
        }
      }
      // Global-sum backstop (rename-proof): the per-file loop only walks OLD
      // keys, so renaming alpha.test.ts (3 tests) → zeta.test.ts while dropping
      // one to 2 — with a matching zeta:2 manifest entry — slips past it (old
      // key reads as a legit deletion, new key never inspected). The TOTAL
      // count, however, still falls (baseTotal 3 → nowTotal 2), which this
      // catches regardless of per-file key churn. A pure rename (no test
      // removed) leaves the sum unchanged and passes; only a NET drop is
      // flagged, mirroring the `--write --allow-lower` guard's intent.
      const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const baseTotal = Object.values(baseline).reduce((a, b) => a + numeric(b), 0);
      const nowTotal = Object.values(manifest).reduce((a, b) => a + numeric(b), 0);
      if (nowTotal < baseTotal) {
        problems.push(
          `total SECURITY: test count DROPPED ${baseTotal} → ${nowTotal} vs the PR base — the NET number of ` +
            `SECURITY: tests fell (a deletion, or a rename that dropped one). Refused by default. ` +
            `If intentional, add the 'allow-security-floor-lower' label and explain it in the PR.`,
        );
      }
    }
  } else {
    console.warn(
      `check-security-test-count: could not read the baseline manifest at ${baselineRef} ` +
        `(${(show.stderr ?? '').trim()}); skipping the lowering guard this run.`,
    );
  }
}

if (problems.length > 0) {
  console.error('check-security-test-count: manifest mismatch:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const expectedTotal = Object.values(manifest).reduce((a, b) => a + b, 0);

// ---- Empty state -----------------------------------------------------------
// A repo with no SECURITY: tests yet (this one, until the runtime is
// extracted; and every freshly-scaffolded agent) has an empty manifest and
// nothing to run. Say so and exit 0 rather than spawning a runner with a
// name-pattern that matches nothing — the gate's job is to notice a count that
// FELL, and zero is a legitimate starting count.
if (expectedTotal === 0) {
  console.log(
    `check-security-test-count: no SECURITY: tests declared (${manifestRel} is empty). ` +
      'Nothing to run — the gate starts enforcing the moment the first one is added.',
  );
  process.exit(0);
}

// ---- Runtime check: every SECURITY: test runs (or SKIPs) and passes -------
// Derive the node:test runner flags from package.json's own "test" script
// (e.g. `--experimental-test-module-mocks`) instead of hardcoding a second
// copy here, so this gate can never silently drift onto a different runtime
// config than `npm test`. Positional arguments (the test globs) are dropped;
// only flags are reused.
const packageJsonPath = path.join(repoRoot, 'package.json');
const testScript = existsSync(packageJsonPath)
  ? (JSON.parse(readFileSync(packageJsonPath, 'utf8')).scripts?.test ?? '')
  : '';
const [, ...testScriptArgs] = testScript.trim().split(/\s+/);
const runnerFlags = testScriptArgs.filter((arg) => arg.startsWith('-'));
if (!runnerFlags.includes('--test')) runnerFlags.push('--test');

const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const result = spawnSync(
  tsxBin,
  [...runnerFlags, '--test-reporter=tap', '--test-name-pattern=^SECURITY:', ...testFiles.map((f) => f.rel)],
  { cwd: repoRoot, encoding: 'utf8' },
);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

if (result.status !== 0) {
  console.error(`\ncheck-security-test-count: tsx --test exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}

const lines = (result.stdout ?? '').split('\n');
const failed = lines.filter((l) => /^not ok \d+ - SECURITY:/.test(l));
// A `# TODO` directive makes node report a test as `ok … # TODO` even when it
// doesn't assert anything — another way to neuter a SECURITY test while
// keeping it green. Treat any TODO-marked SECURITY line as a failure, and
// never credit it toward the pass count. (`# SKIP` stays credited so
// environment-conditional { skip } option tests keep the count stable across
// runners.)
const todo = lines.filter((l) => /^(?:not )?ok \d+ - SECURITY:.*# TODO\b/.test(l));
const passed = lines.filter((l) => /^ok \d+ - SECURITY:/.test(l) && !/# TODO\b/.test(l));

if (failed.length > 0 || todo.length > 0) {
  const bad = [...failed, ...todo];
  console.error(`\ncheck-security-test-count: ${bad.length} SECURITY test(s) failed or were marked TODO:`);
  for (const l of bad) console.error(`  ${l}`);
  process.exit(1);
}

if (passed.length < expectedTotal) {
  console.error(
    `\ncheck-security-test-count: only ${passed.length} SECURITY:-prefixed tests ran, but ` +
      `${manifestRel} expects ${expectedTotal}. A declared security test did not run — ` +
      'check for a broken file glob or a runner config drift.',
  );
  process.exit(1);
}

console.log(
  `\ncheck-security-test-count: ${passed.length} SECURITY:-prefixed tests ran ` +
    `(manifest total: ${expectedTotal} across ${Object.keys(manifest).length} files).`,
);
