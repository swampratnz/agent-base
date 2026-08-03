#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Copies the .sql schema fragments into dist/ as part of `npm run build`.
// `tsc` compiles manifest.ts but never copies the .sql files beside it, so
// without this step dist/ carries a manifest naming fragments that are not
// there — which surfaces as an ENOENT from `migrate` on the deploy box.
//
// This is a Node script rather than a `cp` in the build script because the
// build has to run on Windows too: a release published by hand runs
// prepublishOnly, and `cp` is not a command in cmd.exe. check-dist-schema.mjs
// still adjudicates the result — this only does the copying.
// ---------------------------------------------------------------------------
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'src', 'storage', 'schema');
const distDir = path.join(repoRoot, 'dist', 'storage', 'schema');

const fragments = readdirSync(srcDir).filter((name) => name.endsWith('.sql'));
if (fragments.length === 0) {
  console.error(`copy-schema: no .sql fragments found in ${path.relative(repoRoot, srcDir)}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
for (const name of fragments) {
  copyFileSync(path.join(srcDir, name), path.join(distDir, name));
}

console.log(`copy-schema: copied ${fragments.length} fragments into dist/storage/schema/`);
