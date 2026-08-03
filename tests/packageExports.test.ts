import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published `exports` map.
 *
 * Node's exports map is an ALLOW-LIST: a subpath with no entry fails at
 * resolution with ERR_PACKAGE_PATH_NOT_EXPORTED, and TypeScript reports the
 * same gap as TS2307. 0.1.0 published only `.` and `./package.json`, so the
 * first real consumer — which imports 53 modules directly, because a
 * framework consumed by composition is used through its tree, not through a
 * 15-symbol barrel — could not depend on the package at all without a
 * postinstall script that PATCHED the installed package.json.
 *
 * There is no consumer-side fix for this: `imports` (`#agent-base/*`) cannot
 * target a path inside `node_modules` (ERR_INVALID_PACKAGE_TARGET) and a
 * tsconfig `paths` entry fixes the types while leaving the runtime broken. So
 * it has to be right here, and these assertions are what keep it right.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  files: string[];
};

/**
 * Node's subpath-pattern resolution, reduced to what this map uses: find the
 * pattern keys whose text around the single `*` brackets the specifier,
 * prefer the most specific (longest base, then longest suffix), substitute.
 * Written out rather than assumed, because the whole point of `./*.js`
 * sitting alongside `./*` is that the longer suffix wins — otherwise
 * `router.js` would resolve through `./*` to `dist/router.js.js`.
 */
function resolveSubpath(specifier: string): { types: string; import: string } | null {
  const candidates: { base: string; suffix: string; target: Record<string, string> }[] = [];
  for (const [key, value] of Object.entries(pkg.exports)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const base = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!specifier.startsWith(base) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < base.length + suffix.length) continue;
    candidates.push({ base, suffix, target: value as Record<string, string> });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.base.length - a.base.length || b.suffix.length - a.suffix.length);
  const best = candidates[0];
  const match = specifier.slice(best.base.length, specifier.length - best.suffix.length);
  const substitute = (t: string) => t.replace('*', match);
  return { types: substitute(best.target.types), import: substitute(best.target.import) };
}

/** Every compiled module, as the repo-relative path a specifier addresses. */
function sourceModules(dir = path.join(repoRoot, 'src'), prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceModules(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel.slice(0, -3));
  }
  return out;
}

test('the barrel and package.json stay exactly as they were', () => {
  assert.deepEqual(pkg.exports['.'], { types: './dist/index.d.ts', import: './dist/index.js' });
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.ok(pkg.files.includes('dist'), 'the wildcards are pointless if dist/ is not in the tarball');
});

test('every compiled module is importable by its .js specifier, with types', () => {
  const modules = sourceModules();
  assert.ok(modules.length > 50, `precondition: the tree is large (${modules.length} modules)`);
  for (const mod of modules) {
    const resolved = resolveSubpath(`./${mod}.js`);
    assert.deepEqual(
      resolved,
      { types: `./dist/${mod}.d.ts`, import: `./dist/${mod}.js` },
      `@swampratnz/agent-base/${mod}.js must resolve to dist/${mod}.js and dist/${mod}.d.ts`,
    );
  }
});

test('the extensionless specifier resolves to the same module', () => {
  for (const mod of ['router', 'agent/core', 'storage/repository', 'platforms/types', 'auth/rbac']) {
    assert.deepEqual(resolveSubpath(`./${mod}`), {
      types: `./dist/${mod}.d.ts`,
      import: `./dist/${mod}.js`,
    });
  }
});

test('a built dist/ actually contains what the map promises', (t) => {
  if (!existsSync(path.join(repoRoot, 'dist'))) {
    t.skip('dist/ not built in this working tree — `npm run build` covers this in CI');
    return;
  }
  // The specifiers the first consumer's blocker was filed against, plus the
  // schema manifest a consumer needs for `migrate:prod`.
  const specifiers = [
    './router.js',
    './agent/core.js',
    './storage/repository.js',
    './platforms/types.js',
    './auth/rbac.js',
    './strings/catalogue.js',
    './storage/schema/manifest.js',
  ];
  for (const specifier of specifiers) {
    const resolved = resolveSubpath(specifier);
    assert.ok(resolved, `${specifier} must resolve`);
    for (const target of [resolved.import, resolved.types]) {
      assert.ok(existsSync(path.join(repoRoot, target)), `${specifier} -> ${target} must exist`);
    }
  }
});
