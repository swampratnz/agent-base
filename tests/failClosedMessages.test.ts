import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { flaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { toolServerName } = await import('../src/agent/toolServer.js');
const { registeredCommands } = await import('../src/commands/registry.js');
const { makeWordlistDetector } = await import('../src/moderation/wordlist.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

/**
 * What a fail-closed accessor SAYS when it fires.
 *
 * Nothing here is registered in this process, so every accessor below throws —
 * which is the correct behaviour and is asserted elsewhere. What is asserted
 * here is the message, because a fail-closed error is read by exactly one
 * person, once, at a bad moment, and what it tells them to do is the whole
 * value of failing closed rather than silently serving a narrower surface.
 *
 * Each of these used to name a path in the CONSUMER's repository
 * (`src/module/agent/tools/index.js`) and advise importing it. That was true
 * of community-agent before the extraction, when composition WAS a load-bearing
 * list of side-effect imports — and it is the exact arrangement `createAgent`
 * replaced, precisely because a forgotten import surfaced as a narrower tool
 * surface at first use rather than as a startup error. So the advice was
 * wrong twice over: it named a file that does not exist in this repository,
 * and it described a mechanism that no longer exists in either.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every accessor that fails closed on a missing manifest field, and the field. */
const ACCESSORS: readonly { label: string; field: string; read: () => unknown }[] = [
  { label: 'tool tiers', field: 'toolTiers', read: () => toolsForRole('member') },
  { label: 'tool-server parts', field: 'toolServerParts', read: () => toolServerName() },
  { label: 'flagged-tool predicates', field: 'flaggedToolPredicates', read: () => flaggedToolPredicates() },
  { label: 'commands', field: 'commands', read: () => registeredCommands() },
  { label: 'default bad words', field: 'defaultBadWords', read: () => makeWordlistDetector() },
];

test('SECURITY: every fail-closed message names the manifest field that fixes it', () => {
  for (const { label, field, read } of ACCESSORS) {
    let message = '';
    try {
      read();
      assert.fail(`${label}: the accessor must throw when nothing is registered`);
    } catch (err) {
      message = (err as Error).message;
    }
    assert.ok(message.includes(field), `${label}: the message must name \`${field}\` — got: ${message}`);
    assert.match(message, /manifest/, `${label}: the message must point at the manifest`);
    assert.doesNotMatch(
      message,
      /src\/module\//,
      `${label}: the message must not name a path in the consumer's repository`,
    );
    assert.doesNotMatch(
      message,
      /\bimport the\b/,
      `${label}: registration is not an import — advising one sends the reader to a mechanism that no longer exists`,
    );
  }
});

/** Every `.ts` under `src/`, recursively. */
function sourceFiles(dir = path.join(repoRoot, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no base source file points at a path in the consumer repository', () => {
  // The wider version of the same rule, and the reason it is worth a test
  // rather than a review habit: base was extracted FROM the consumer, so every
  // one of these paths was correct in its previous life and none of them looks
  // wrong in isolation. A second consumer inherits every one as a dead
  // pointer. `src/module/` is the consumer's tree by convention, so the string
  // has no legitimate use here.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (line.includes('src/module/')) {
        offenders.push(`${path.relative(repoRoot, file)}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these name a path that exists only in a consumer repository; describe the mechanism instead',
  );
});
