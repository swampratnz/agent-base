#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The consumption test, as a single local command (issue #35).
//
// Does a CONSUMER work? Pack the real tarball, scaffold template/ into a temp
// directory, install the tarball (NEVER a link — a link resolves through src/
// and silently answers "yes" to every question this exists to ask), run the
// scaffold's own gate, migrate, and run both boot smokes.
//
// This is the same sequence consumption.yml's `consume` job runs — the
// workflow invokes THIS script, so CI runs exactly what a contributor runs.
// That equivalence is the point: the build worker's rule is "green locally
// matches CI", and it broke the day the consumption checks existed only as
// workflow bash. What deliberately stays workflow-level is what one local run
// cannot reproduce: the toolchain matrix (Node 22/24, npm 11/bundled), the
// Windows/macOS packs, the npm 12 + Baileys job and the cross-repo canary —
// those are post-merge signals, not pre-PR ones (docs/PIPELINE.md).
//
// Needs DATABASE_URL (the scaffold migrates and runs its DB-backed tests
// against it — use your OWN database, per CLAUDE.md). Without it the script
// SKIPS, visibly and successfully: a contributor with no local Postgres is not
// blocked, but a skip proves nothing and says so.
// ---------------------------------------------------------------------------
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.DATABASE_URL) {
  // Visible, never silent: the skip is a fact the reader must see, because a
  // green run that skipped proves nothing about the package.
  console.log('consumption-test: SKIPPED — DATABASE_URL is unset.');
  console.log('  The scaffold migrates and runs DB-backed tests for real; point DATABASE_URL');
  console.log('  at your own Postgres 16 + pgvector database and re-run for the full check.');
  process.exit(0);
}

// The scaffold's config parse wants these present; values are irrelevant
// because no adapter is constructed. `??=` keeps whatever the caller set
// (consumption.yml sets its own fixtures at job level).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'smoke-not-a-real-token';
process.env.DISCORD_BOT_TOKEN ??= 'smoke-not-a-real-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

// npm on Windows is npm.cmd, which spawnSync only finds through a shell.
const shell = process.platform === 'win32';
let workDir;

function fail(message) {
  console.error(`\nconsumption-test: FAIL — ${message}`);
  if (workDir) console.error(`work dir kept for inspection: ${workDir}`);
  process.exit(1);
}

/** Run a command with inherited stdio; any nonzero exit fails the whole test. */
function run(label, cmd, args, cwd) {
  console.log(`\n== ${label}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell, cwd });
  if (res.status !== 0) fail(`'${label}' exited ${res.status ?? `on signal ${res.signal}`}`);
}

/** Run a command capturing output — for the boot smokes, which assert on it. */
function capture(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', shell, cwd });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function sqlCount(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).length;
}

workDir = mkdtempSync(path.join(os.tmpdir(), 'agent-base-consumption-'));
const packDir = path.join(workDir, 'pkg');
const appDir = path.join(workDir, 'app');
mkdirSync(packDir);

// -- Build and pack the real artifact. `npm pack` does NOT run prepublishOnly
//    (that fires on publish only) and there is no prepack hook, so dist/ must
//    be built explicitly or the tarball ships stale or empty.
run('build', 'npm', ['run', 'build'], repoRoot);
run('pack the real artifact', 'npm', ['pack', '--pack-destination', packDir], repoRoot);
const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
if (tarballs.length !== 1) fail(`expected exactly one tarball in ${packDir}, found ${tarballs.length}`);
const tarball = path.join(packDir, tarballs[0]);

// -- Scaffold template/ into a fresh directory and install the tarball.
cpSync(path.join(repoRoot, 'template'), appDir, { recursive: true });
run(
  'install the packed tarball (never a link)',
  'npm',
  ['install', tarball, '--no-audit', '--no-fund'],
  appDir,
);

// The scaffold's own declared range must ADMIT the version this repo builds. A
// caret on a 0.x major pins the minor, so template/'s range needs bumping on
// every framework minor — this is what stops issue #21 recurring silently.
const installedVersion = JSON.parse(
  readFileSync(path.join(appDir, 'node_modules', '@swampratnz', 'agent-base', 'package.json'), 'utf8'),
).version;
const repoVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
console.log(`installed @swampratnz/agent-base@${installedVersion}; this repo builds ${repoVersion}`);
if (installedVersion !== repoVersion) {
  fail(
    `template/ resolved ${installedVersion} but this repo builds ${repoVersion} — bump template/package.json's range`,
  );
}

// -- The scaffolded repo's OWN gate, exactly as its package.json defines it.
//    Not a re-run of ours: the gate scripts execute out of
//    node_modules/@swampratnz/agent-base/scripts/ with `--root .`, which is the
//    arrangement a real scaffolded repo uses and nothing else tests.
for (const script of [
  'typecheck',
  'lint',
  'format:check',
  'test',
  'build',
  'test:security',
  'context:check',
]) {
  run(`scaffold gate: npm run ${script}`, 'npm', ['run', script], appDir);
}

// -- Migrate, and prove the SQL fragments travelled in the tarball.
//    check-dist-schema.mjs proves dist/ matches the manifest in OUR tree;
//    nothing else proves the fragments reached a consumer — and a consumer that
//    installs this and cannot migrate is broken in a way no unit test sees.
run('scaffold: npm run migrate', 'npm', ['run', 'migrate'], appDir);
const shipped = sqlCount(
  path.join(appDir, 'node_modules', '@swampratnz', 'agent-base', 'dist', 'storage', 'schema'),
);
const expected = sqlCount(path.join(repoRoot, 'src', 'storage', 'schema'));
console.log(`fragments: ${shipped} shipped, ${expected} in source`);
if (shipped !== expected) fail(`${expected} .sql fragments in src/ but ${shipped} in the installed package`);

// -- Boot smoke, negative half: the scaffold registers only promptSections, so
//    createAgent must refuse and name every gap AT ONCE. Asserting the exact
//    expected failure means any OTHER failure — an import-time throw, a
//    resolution error, a config parse — fails this step too, because it would
//    not produce this message.
console.log('\n== boot smoke: an incomplete composition is refused, naming every gap');
const negative = capture('node', ['dist/main.js'], appDir);
console.log(negative.out);
if (negative.status === 0)
  fail('the scaffold booted, but template/ registers only promptSections — it must refuse');
if (!negative.out.includes('8 problem(s) with this composition')) {
  fail('expected all 8 missing registrations reported at once');
}
for (const gap of [
  'notice pack',
  'tool tiers',
  'tool-server parts',
  'flagged-tool predicates',
  'skills manifest',
  'commands',
  'default bad words',
  'default persona',
]) {
  if (!negative.out.includes(gap)) fail(`the refusal did not name: ${gap}`);
}

// -- Boot smoke, positive half: a minimal COMPLETE composition starts, from
//    the installed package. boot.mjs lives outside the tarball on purpose (it
//    tests the package, so it must not be part of it) and is copied in here.
console.log('\n== boot smoke: a COMPLETE composition starts, from the installed package');
copyFileSync(path.join(repoRoot, '.github', 'smoke', 'boot.mjs'), path.join(appDir, 'boot.mjs'));
const positive = capture('node', ['boot.mjs'], appDir);
console.log(positive.out);
if (!positive.out.includes('SMOKE OK')) fail('a complete composition failed to reach started');

rmSync(workDir, { recursive: true, force: true });
console.log('\nconsumption-test: PASS — the packed tarball scaffolds, gates, migrates and boots.');
