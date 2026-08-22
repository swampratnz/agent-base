#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Three-way template upgrade for a scaffolded repo.
//
// A repo scaffolded from template/ has no mechanical way to take template
// fixes: the copy was a one-shot, and the moment the consumer edits a file,
// "just re-copy" destroys their work. This script does the copier-style
// three-way comparison instead (reviewed from metaharness's upgrade planner
// in bosun's docs/metaharness-feature-review.md §A1 — including the bug found
// there: upstream-ADDED files land in directories that may not exist yet, so
// every write here mkdirs first). Per file, three states are compared:
//
//   old    = the hash recorded in the scaffold's template.manifest.json
//            (written into template/ at scaffold time — generation-time truth)
//   new    = the current template file
//   local  = the scaffold's on-disk file
//
//   local == old            -> clean: overwrite with new (the consumer never
//                              touched it; taking the fix is safe)
//   local == new            -> already current: skip
//   old == new              -> kept: the consumer edited it but upstream did
//                              not change it, so there is nothing to merge
//   local missing           -> add (mkdir -p first)
//   otherwise               -> conflict: the consumer edited a file upstream
//                              also changed — inline <<<<<<</>>>>>>> markers
//                              (default) or a .rej file; a human resolves it
//
// Files recorded in the manifest but gone from the current template are
// reported and LEFT IN PLACE — deleting a consumer's file is never this
// script's call. After a non-dry run the scaffold's manifest is rewritten to
// the new template's, so the next upgrade compares against the right "old".
//
// Run it from a checkout of agent-base at the version you are upgrading TO
// (the npm package ships scripts/ but not template/, so the checkout supplies
// the new template):
//
//   node scripts/upgrade-template.mjs --scaffold ../my-agent [--dry-run]
//
//   --scaffold <dir>   the scaffolded repo to upgrade (required)
//   --template <dir>   the new template (default: this checkout's template/)
//   --conflict <mode>  inline (default) or rej
//   --dry-run          print the plan; write nothing
//
// Exits 1 when conflicts exist (planned or written) — they need a human —
// else 0.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  buildManifest,
  hashTemplateFile,
  listTemplateFiles,
  manifestJson,
} from './check-template-manifest.mjs';

const MANIFEST_NAME = 'template.manifest.json';

function flagValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}

/** The plan: what an upgrade would do, computed without writing anything. */
export function planUpgrade(templateDir, scaffoldDir) {
  const manifestPath = path.join(scaffoldDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${scaffoldDir} has no ${MANIFEST_NAME} — the scaffold predates the manifest. ` +
        `Seed it from a checkout of the template version the scaffold WAS generated from ` +
        `(npm run template:fix there, copy template/${MANIFEST_NAME} in), then re-run.`,
    );
  }
  const recorded = JSON.parse(readFileSync(manifestPath, 'utf8')).files ?? {};
  const plan = { add: [], update: [], conflict: [], current: [], localOnly: [], removedUpstream: [] };
  for (const rel of listTemplateFiles(templateDir)) {
    const newHash = hashTemplateFile(path.join(templateDir, rel));
    const localAbs = path.join(scaffoldDir, rel);
    const old = recorded[rel];
    if (!existsSync(localAbs)) {
      plan.add.push(rel);
      continue;
    }
    const localHash = hashTemplateFile(localAbs);
    if (localHash === newHash) plan.current.push(rel);
    else if (localHash === old) plan.update.push(rel);
    // Upstream did not change this file, so a local edit has nothing to merge
    // with — kept as-is. Only a genuine both-sides change is a conflict.
    else if (old === newHash) plan.localOnly.push(rel);
    else plan.conflict.push(rel);
  }
  for (const rel of Object.keys(recorded)) {
    if (!existsSync(path.join(templateDir, rel))) plan.removedUpstream.push(rel);
  }
  return plan;
}

/** Apply a plan. Every write mkdirs its parent first — upstream-added files land in new directories. */
export function applyUpgrade(templateDir, scaffoldDir, plan, { conflictMode = 'inline' } = {}) {
  const write = (rel, content) => {
    const abs = path.join(scaffoldDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const rel of [...plan.add, ...plan.update]) {
    write(rel, readFileSync(path.join(templateDir, rel)));
  }
  for (const rel of plan.conflict) {
    const upstream = readFileSync(path.join(templateDir, rel), 'utf8');
    if (conflictMode === 'rej') {
      write(`${rel}.rej`, upstream);
    } else {
      const local = readFileSync(path.join(scaffoldDir, rel), 'utf8');
      // Both chunks end with exactly one newline so the markers sit on their
      // own lines even when a file lacks a trailing newline.
      const nl = (s) => (s.endsWith('\n') ? s : `${s}\n`);
      write(
        rel,
        `<<<<<<< scaffold (your edits)\n${nl(local)}=======\n${nl(upstream)}>>>>>>> template (upstream)\n`,
      );
    }
  }
  // Reset the baseline so the NEXT upgrade three-ways against this template.
  write(MANIFEST_NAME, manifestJson(buildManifest(templateDir)));
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const scaffoldArg = flagValues(argv, '--scaffold').at(-1);
  if (!scaffoldArg) {
    console.error('upgrade-template: --scaffold <dir> is required');
    process.exit(1);
  }
  const scaffoldDir = path.resolve(scaffoldArg);
  const templateDir = flagValues(argv, '--template').at(-1)
    ? path.resolve(flagValues(argv, '--template').at(-1))
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'template');
  const conflictMode = flagValues(argv, '--conflict').at(-1) ?? 'inline';
  if (!['inline', 'rej'].includes(conflictMode)) {
    console.error(`upgrade-template: --conflict must be inline or rej (got ${conflictMode})`);
    process.exit(1);
  }

  let plan;
  try {
    plan = planUpgrade(templateDir, scaffoldDir);
  } catch (err) {
    console.error(`upgrade-template: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const dryRun = argv.includes('--dry-run');
  const say = (label, files) => {
    if (files.length > 0) console.log(`${label}:\n${files.map((f) => `  ${f}`).join('\n')}`);
  };
  say('add (new upstream)', plan.add);
  say('update (clean overwrite)', plan.update);
  say('kept (local edits; upstream unchanged)', plan.localOnly);
  say(
    `conflict (${conflictMode === 'rej' ? '.rej written' : 'inline markers'}; resolve by hand)`,
    plan.conflict,
  );
  say('removed upstream (left in place)', plan.removedUpstream);
  console.log(`${plan.current.length} file(s) already current.`);

  if (!dryRun) {
    applyUpgrade(templateDir, scaffoldDir, plan, { conflictMode });
    console.log(`upgrade-template: applied; ${MANIFEST_NAME} baseline reset to the new template.`);
  } else {
    console.log('upgrade-template: dry run — nothing written.');
  }
  process.exit(plan.conflict.length > 0 ? 1 : 0);
}
