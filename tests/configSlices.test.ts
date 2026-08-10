import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/config.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { config, loadConfig } = await import('../src/config.js');

// The minimal valid environment: exactly the four required vars, nothing
// inherited from this process, so every other key exercises its default.
const MINIMAL_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_GUILD_ID: '1',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
};

/**
 * Recursive key-structure fingerprint: nested plain objects keep their (sorted)
 * keys, every other value collapses to 'leaf'. Values are deliberately NOT
 * compared — the singleton `config` was parsed from this process's env (which
 * CI may decorate with real DATABASE_URL/LOG_LEVEL), so only the SHAPE is
 * guaranteed to match a from-scratch minimal parse.
 */
function keyShape(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'leaf';
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, keyShape(v)]),
  );
}

test('loadConfig: a minimal valid env yields the exact key structure of the exported config singleton (config-split anti-drift)', () => {
  const built = loadConfig(MINIMAL_ENV);
  assert.deepEqual(
    keyShape(built),
    keyShape(config),
    'loadConfig must produce the same 33-section config shape the barrel singleton exports — a slice ' +
      'dropped or renamed during composition would diverge here',
  );
});

test('loadConfig: defaults survive the slice split — spot checks across every kind of slice', () => {
  const built = loadConfig(MINIMAL_ENV);
  // llm slice
  assert.equal(built.llm.maxTurns, 12);
  assert.equal(built.llm.memberModel, undefined);
  // db slice (shared with the boot path)
  assert.equal(built.db.embeddingDim, 384);
  assert.equal(built.db.statementTimeoutMs, 15_000);
  // whatsapp slice
  assert.equal(built.whatsapp.cloud.webhookPort, 8080);
  // behaviour slice
  assert.equal(built.behaviour.agentTurnTimeoutMs, 300_000);
  assert.equal(built.behaviour.dailyReplyLimitPerUser, 50);
  // alerts slice
  assert.equal(built.adminDigest.knowledgeStaleDays, 0);
  // knowledge slice: the two upstream URLs deliberately have NO default —
  // a framework must not ship one vendor's endpoint as every agent's
  // fallback. They are required only when their feature is enabled
  // (knowledgeRefinements), which the next test pins.
  assert.equal(built.statusCheck.apiUrl, undefined);
  assert.equal(built.docsIngest.indexUrl, undefined);
  // behaviour slice: neutral display defaults, not a deployment's timezone.
  assert.equal(built.behaviour.displayTimezone, 'UTC');
  assert.equal(built.behaviour.displayLocale, 'en-GB');
  // log slice (shared with the boot path)
  assert.equal(built.log.level, 'info');
  assert.equal(built.log.pretty, false);
});

test('loadConfig: blank strings are treated as unset, same as the singleton parse', () => {
  const built = loadConfig({ ...MINIMAL_ENV, HEALTH_PORT: '', AGENT_MODEL_MEMBER: '' });
  assert.equal(built.behaviour.healthPort, undefined);
  assert.equal(built.llm.memberModel, undefined);
});

test('loadConfig: several invalid vars are reported TOGETHER in one thrown error, not first-only', () => {
  assert.throws(
    () =>
      loadConfig({
        ...MINIMAL_ENV,
        AGENT_MAX_TURNS: '0',
        DB_STATEMENT_TIMEOUT_MS: '0',
        LOG_LEVEL: 'bogus',
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Invalid environment configuration:/);
      assert.match(err.message, /AGENT_MAX_TURNS/);
      assert.match(err.message, /DB_STATEMENT_TIMEOUT_MS/);
      assert.match(err.message, /LOG_LEVEL/);
      return true;
    },
  );
});

test('loadConfig: refinements from DIFFERENT slices still aggregate into one error', () => {
  assert.throws(
    () =>
      loadConfig({
        ...MINIMAL_ENV,
        // behaviour-slice refinement (7-day floor)
        INTERACTION_RETENTION_DAYS: '2',
        // alerts-slice refinement (30-day floor)
        KNOWLEDGE_STALE_DAYS: '5',
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /INTERACTION_RETENTION_DAYS must be 0 \(disabled\) or at least 7/);
      assert.match(err.message, /KNOWLEDGE_STALE_DAYS must be 0 \(disabled\) or at least 30/);
      return true;
    },
  );
});

test('loadConfig: the cross-slice AGENT_TURN_TIMEOUT_MS > IMAGE_GEN_TIMEOUT_MS refine survives the split (issue #826)', () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL_ENV, AGENT_TURN_TIMEOUT_MS: '180000', IMAGE_GEN_TIMEOUT_MS: '180000' }),
    /AGENT_TURN_TIMEOUT_MS must be strictly greater than IMAGE_GEN_TIMEOUT_MS/,
  );
  // And the happy path still loads.
  const built = loadConfig({
    ...MINIMAL_ENV,
    AGENT_TURN_TIMEOUT_MS: '240000',
    IMAGE_GEN_TIMEOUT_MS: '180000',
  });
  assert.equal(built.behaviour.agentTurnTimeoutMs, 240_000);
});

// ---------------------------------------------------------------------------
// Boot decoupling (the regression test that retires migrate:ci's dummy token):
// the storage/logging spine must import cleanly with ONLY DATABASE_URL set and
// the app-level required vars EXPLICITLY empty. Before the config split,
// logger.ts/storage/db.ts pulled the FULL schema at import and exited(1)
// demanding CLAUDE_CODE_OAUTH_TOKEN/DISCORD_BOT_TOKEN/DISCORD_GUILD_ID — vars
// migrate never uses.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function importInBootEnv(code: string) {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--input-type=module', '-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CLAUDE_CODE_OAUTH_TOKEN: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_GUILD_ID: '',
      // Deliberately unreachable — nothing here may ever CONNECT; importing
      // the pool module must not touch the network.
      DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
    },
  });
}

test("boot decoupling: migrate's import chain (storage/db + logger) loads with only DATABASE_URL set — no exit(1) for missing CLAUDE_CODE_OAUTH_TOKEN/DISCORD_*", () => {
  const result = importInBootEnv(
    "await import('./src/storage/db.js'); await import('./src/logger.js'); console.log('BOOT OK')",
  );
  assert.equal(
    result.status,
    0,
    `boot chain must import cleanly; stdout: ${result.stdout}; stderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /BOOT OK/);
});

test('boot decoupling control: the FULL config barrel still fails fast in that same env — proving the rig would catch a re-coupling', () => {
  const result = importInBootEnv("await import('./src/config.js'); console.log('BARREL LOADED')");
  assert.notEqual(result.status, 0, 'the full barrel must still demand its required vars');
  assert.doesNotMatch(result.stdout, /BARREL LOADED/);
  assert.match(`${result.stderr}${result.stdout}`, /CLAUDE_CODE_OAUTH_TOKEN/);
});

// --- Extraction residue: no vendor URL defaults, no pinned timezone ---------
//
// community-agent defaulted DOCS_INGEST_INDEX_URL to Anthropic's llms.txt and
// STATUS_CHECK_API_URL to Anthropic's Statuspage, and pinned Pacific/Auckland
// in util/nzTime.ts. A framework cannot ship one deployment's endpoints or
// timezone as everyone's fallback, so the URLs lost their defaults and gained
// a required-when-enabled refinement, and the timezone/locale became env.

test('loadConfig: enabling a fetcher without its URL is a BOOT error, not a silently no-op job', () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL_ENV, DOCS_INGEST_ENABLED: 'true' }),
    /DOCS_INGEST_INDEX_URL is required when DOCS_INGEST_ENABLED is true/,
  );
  assert.throws(
    () => loadConfig({ ...MINIMAL_ENV, STATUS_CHECK_ENABLED: 'true' }),
    /STATUS_CHECK_API_URL is required when STATUS_CHECK_ENABLED is true/,
  );
  const ok = loadConfig({
    ...MINIMAL_ENV,
    DOCS_INGEST_ENABLED: 'true',
    DOCS_INGEST_INDEX_URL: 'https://docs.example.test/llms.txt',
    STATUS_CHECK_ENABLED: 'true',
    STATUS_CHECK_API_URL: 'https://status.example.test/api/v2/summary.json',
  });
  assert.equal(ok.docsIngest.indexUrl, 'https://docs.example.test/llms.txt');
  assert.equal(ok.statusCheck.apiUrl, 'https://status.example.test/api/v2/summary.json');
});

test('loadConfig: DISPLAY_TIMEZONE/DISPLAY_LOCALE are validated by Intl at boot, not at first render', () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL_ENV, DISPLAY_TIMEZONE: 'Middle/Earth' }),
    /DISPLAY_TIMEZONE must be a valid IANA timezone/,
  );
  const nz = loadConfig({ ...MINIMAL_ENV, DISPLAY_TIMEZONE: 'Pacific/Auckland', DISPLAY_LOCALE: 'en-NZ' });
  assert.equal(nz.behaviour.displayTimezone, 'Pacific/Auckland');
  assert.equal(nz.behaviour.displayLocale, 'en-NZ');
});

// --- Guarded page fetching --------------------------------------------------

test('SECURITY: loadConfig refuses FETCH_PAGE_ENABLED without an allowlist — caller-driven egress must never boot as an open proxy', () => {
  // A tool that refused every call at runtime would look like a bug to whoever
  // just enabled it. Failing at boot names the missing decision instead.
  assert.throws(
    () => loadConfig({ ...MINIMAL_ENV, FETCH_PAGE_ENABLED: 'true' }),
    /FETCH_PAGE_ALLOWED_HOSTS is required when FETCH_PAGE_ENABLED=true/,
  );
  assert.throws(
    () => loadConfig({ ...MINIMAL_ENV, FETCH_PAGE_ENABLED: 'true', FETCH_PAGE_ALLOWED_HOSTS: '   ' }),
    /FETCH_PAGE_ALLOWED_HOSTS is required when FETCH_PAGE_ENABLED=true/,
    'whitespace is not an allowlist',
  );
});

test('loadConfig: fetch-page defaults are off, and the allowlist parses to a trimmed list', () => {
  const off = loadConfig(MINIMAL_ENV);
  assert.equal(off.fetchPage.enabled, false, 'off unless explicitly enabled');
  assert.deepEqual(off.fetchPage.allowedHosts, []);

  const on = loadConfig({
    ...MINIMAL_ENV,
    FETCH_PAGE_ENABLED: 'true',
    FETCH_PAGE_ALLOWED_HOSTS: 'docs.example.test, .example.org ',
  });
  assert.equal(on.fetchPage.enabled, true);
  assert.deepEqual(on.fetchPage.allowedHosts, ['docs.example.test', '.example.org']);
  assert.equal(on.fetchPage.maxBytes, 512_000);
  assert.equal(on.fetchPage.maxRedirects, 3);
});
