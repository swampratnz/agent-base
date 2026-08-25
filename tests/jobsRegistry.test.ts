import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// The job-runner pins that src/jobs/runner.ts, src/jobs/types.ts and
// src/retention.ts have referenced since extraction — the original
// jobsRegistry.test.ts stayed behind in community-agent, where it pins that
// deployment's own JOB_REGISTRY. What base owns, and what is pinned here, is
// the RUNNER's contract: it starts every spec it is handed and never consults
// the declarative `enabled` gate — plus the `enabled` mirrors on base's own
// retention job specs.
import type { Config } from '../src/config.js';
import type { JobSpec } from '../src/jobs/types.js';
import { startRegisteredJobs, stopRegisteredJobs } from '../src/jobs/runner.js';

const retention = await import('../src/retention.js');

/** A spec whose starter records the call; `timer` distinguishes gated-off (null) from started. */
function recordingSpec(name: string, opts: { enabled: boolean; starts: boolean }, calls: string[]): JobSpec {
  return {
    name,
    enabled: () => {
      calls.push(`enabled:${name}`);
      return opts.enabled;
    },
    start: () => {
      calls.push(`start:${name}`);
      return opts.starts ? setInterval(() => {}, 2 ** 30).unref() : null;
    },
  };
}

test('SECURITY: startRegisteredJobs never consults spec.enabled — a drifted or hostile declarative gate can neither suppress a retention job nor start a disabled one', () => {
  // The starters self-gate internally; `enabled` is inspection metadata. If
  // the runner ever started consulting it, a mislabelled gate could silently
  // suppress a retention purge (data kept past its policy) or start a job its
  // own gate says is off — so the pin is that `enabled` is NEVER called and
  // `start` is ALWAYS called, in list order, whatever `enabled` claims.
  const calls: string[] = [];
  const specs = [
    recordingSpec('claims-disabled', { enabled: false, starts: true }, calls),
    recordingSpec('claims-enabled', { enabled: true, starts: true }, calls),
    recordingSpec('self-gated-off', { enabled: true, starts: false }, calls),
  ];
  const started = startRegisteredJobs(specs, []);
  try {
    assert.deepEqual(calls, ['start:claims-disabled', 'start:claims-enabled', 'start:self-gated-off']);
    assert.deepEqual(
      started.map((job) => ({ name: job.name, running: job.timer !== null })),
      [
        { name: 'claims-disabled', running: true },
        { name: 'claims-enabled', running: true },
        { name: 'self-gated-off', running: false },
      ],
    );
  } finally {
    stopRegisteredJobs(started);
  }
});

test('stopRegisteredJobs clears every started timer and skips gated-off nulls; a second sweep is a no-op', (t) => {
  const cleared: unknown[] = [];
  const realClearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, 'clearInterval', (timer: Parameters<typeof clearInterval>[0]) => {
    cleared.push(timer);
    return realClearInterval(timer);
  });
  const calls: string[] = [];
  const started = startRegisteredJobs(
    [
      recordingSpec('running', { enabled: true, starts: true }, calls),
      recordingSpec('off', { enabled: true, starts: false }, calls),
    ],
    [],
  );
  stopRegisteredJobs(started);
  assert.equal(cleared.length, 1, 'exactly the one live timer is cleared; the null is skipped');
  stopRegisteredJobs(started);
  assert.equal(cleared.length, 2, 'clearing is idempotent — a second sweep just re-clears');
});

test("each retention job's declarative `enabled` mirrors its starter's own `days > 0` gate", () => {
  // The comment in retention.ts promises this mirror; drive each spec's
  // `enabled` with a synthetic config so the metadata can never drift from
  // the gate it describes without failing here.
  const cases: ReadonlyArray<{ spec: JobSpec; key: string }> = [
    { spec: retention.interactionRetentionPurgeJob, key: 'interactionRetentionDays' },
    { spec: retention.rosterRetentionPurgeJob, key: 'rosterDepartedRetentionDays' },
    { spec: retention.accessRequestRetentionPurgeJob, key: 'accessRequestRetentionDays' },
  ];
  for (const { spec, key } of cases) {
    const cfg = (days: number) => ({ behaviour: { [key]: days } }) as unknown as Config;
    assert.equal(spec.enabled(cfg(30)), true, `${spec.name} must report enabled when ${key} > 0`);
    assert.equal(spec.enabled(cfg(0)), false, `${spec.name} must report disabled when ${key} is 0`);
  }
});
