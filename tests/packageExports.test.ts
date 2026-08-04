import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
 *
 * The second half of the same lesson is the CONDITION set. 0.1.1 published
 * `{types, import}`, which exports the tree to ESM resolution and to nothing
 * else — every other condition, `require` first among them, falls off the end
 * of the map and reports ERR_PACKAGE_PATH_NOT_EXPORTED. That error names the
 * wrong problem: the subpath IS exported, it is only ESM-shaped. A `default`
 * catch-all makes the map say that instead.
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
function resolveSubpath(specifier: string): { types: string; import: string; default: string } | null {
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
  return {
    types: substitute(best.target.types),
    import: substitute(best.target.import),
    default: substitute(best.target.default),
  };
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
  assert.deepEqual(pkg.exports['.'], {
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  });
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
      { types: `./dist/${mod}.d.ts`, import: `./dist/${mod}.js`, default: `./dist/${mod}.js` },
      `@swampratnz/agent-base/${mod}.js must resolve to dist/${mod}.js and dist/${mod}.d.ts`,
    );
  }
});

test('the extensionless specifier resolves to the same module', () => {
  for (const mod of ['router', 'agent/core', 'storage/repository', 'platforms/types', 'auth/rbac']) {
    assert.deepEqual(resolveSubpath(`./${mod}`), {
      types: `./dist/${mod}.d.ts`,
      import: `./dist/${mod}.js`,
      default: `./dist/${mod}.js`,
    });
  }
});

/**
 * Order is not cosmetic here: Node takes the FIRST matching condition, so a
 * `default` written above `import` would swallow every other condition and a
 * `default` written above `types` would take the `.js` away from TypeScript.
 * The catch-all only behaves like a catch-all when it is last.
 */
test('every conditional target lists default last, after types and import', () => {
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value === 'string') continue; // ./package.json, a bare target
    const conditions = Object.keys(value as Record<string, string>);
    assert.deepEqual(
      conditions,
      ['types', 'import', 'default'],
      `${key}: conditions are matched in declaration order, so default must come last`,
    );
  }
});

/**
 * The behavioural half — the previous four tests re-implement Node's pattern
 * matching, and a map can satisfy a re-implementation while still failing the
 * real resolver. This asks Node itself, through both loaders, via the package
 * self-reference (a package can resolve its own name once it declares
 * `exports`). `createRequire().resolve()` is the exact call that failed in
 * community-agent#960.
 */
test('Node resolves these specifiers under both the import and require conditions', (t) => {
  if (!existsSync(path.join(repoRoot, 'dist'))) {
    t.skip('dist/ not built in this working tree — `npm run build` covers this in CI');
    return;
  }
  const require = createRequire(import.meta.url);
  for (const mod of ['router', 'auth/rbac', 'agent/outbound']) {
    const specifier = `@swampratnz/agent-base/${mod}.js`;
    const expected = path.join(repoRoot, 'dist', `${mod}.js`);

    // The require condition — ERR_PACKAGE_PATH_NOT_EXPORTED before `default`.
    assert.equal(require.resolve(specifier), expected, `require: ${specifier}`);

    // The import condition, which worked all along and must keep working.
    assert.equal(fileURLToPath(import.meta.resolve(specifier)), expected, `import: ${specifier}`);
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
