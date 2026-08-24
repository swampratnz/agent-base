import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FleetHeartbeat,
  readFleetHeartbeatConfig,
  spendSince,
  startFleetHeartbeat,
} from '../src/fleet/heartbeat.js';
import type { Queryable } from '../src/storage/repository/shared.js';

const ENV = {
  FLEET_AGENT_ID: 'community-agent-01',
  FLEET_AGENT_TYPE: 'community-agent',
  FLEET_SUPERVISOR_URL: 'http://127.0.0.1:7177',
};

const NOW = new Date('2026-08-23T12:00:00Z');

/** A Queryable that records what it was asked and answers with fixed rows. */
function fakeDb(rows: unknown[], onQuery?: (sql: string, params: unknown[]) => void): Queryable {
  return {
    query: (async (sql: string, params: unknown[]) => {
      onQuery?.(sql, params);
      return { rows };
    }) as Queryable['query'],
  };
}

function fakeFetch(
  record: Array<{ url: string; body: unknown; headers?: Record<string, string> }>,
  ok = true,
  status?: number,
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : 'null';
    record.push({
      url: String(url),
      body: JSON.parse(raw) as unknown,
      headers: init?.headers as Record<string, string> | undefined,
    });
    return { ok, status: status ?? (ok ? 200 : 503) } as Response;
  }) as unknown as typeof fetch;
}

// ── configuration: inert unless a supervisor is actually configured ──────────

test('readFleetHeartbeatConfig: returns undefined outside a bosun fleet', () => {
  assert.equal(readFleetHeartbeatConfig({}), undefined);
});

test('readFleetHeartbeatConfig: a half-configured agent stays inert', () => {
  // No enable flag: the presence of a supervisor IS the flag, so a missing
  // piece must mean off rather than reporting to a half-finished URL.
  assert.equal(readFleetHeartbeatConfig({ FLEET_AGENT_ID: 'x' }), undefined);
  assert.equal(readFleetHeartbeatConfig({ ...ENV, FLEET_SUPERVISOR_URL: '' }), undefined);
});

test('readFleetHeartbeatConfig: reads the supervisor-injected identity', () => {
  const cfg = readFleetHeartbeatConfig({ ...ENV, FLEET_HEARTBEAT_SECONDS: '15' });
  assert.equal(cfg?.agentId, 'community-agent-01');
  assert.equal(cfg?.intervalMs, 15_000);
  assert.ok(cfg && cfg.timeoutMs < cfg.intervalMs, 'timeout must fit inside the interval');
});

test('readFleetHeartbeatConfig: trims a trailing slash and defaults a bad interval', () => {
  const cfg = readFleetHeartbeatConfig({
    ...ENV,
    FLEET_SUPERVISOR_URL: 'http://x:7177/',
    FLEET_HEARTBEAT_SECONDS: 'nope',
  });
  assert.equal(cfg?.supervisorUrl, 'http://x:7177');
  assert.equal(cfg?.intervalMs, 30_000);
});

test('startFleetHeartbeat: does nothing at all when unconfigured', () => {
  let touched = false;
  const db = fakeDb([], () => {
    touched = true;
  });
  assert.equal(startFleetHeartbeat({}, { db }), null);
  assert.equal(touched, false, 'an agent outside a fleet must not even query');
});

// ── the spend query ─────────────────────────────────────────────────────────

test('spendSince: sums per model and windows on the watermark', async () => {
  let seenSql = '';
  let seenParams: unknown[] = [];
  const db = fakeDb(
    [
      { model: 'claude-opus-5', cost: '0.42' },
      { model: 'claude-sonnet-5', cost: '0.08' },
    ],
    (sql, params) => {
      seenSql = sql;
      seenParams = params;
    },
  );
  const usage = await spendSince(db, NOW);
  assert.deepEqual(usage, [
    { model: 'claude-opus-5', costUsd: 0.42 },
    { model: 'claude-sonnet-5', costUsd: 0.08 },
  ]);
  assert.deepEqual(seenParams, [NOW]);
  // A strictly-greater window is what stops two reports counting one row twice.
  assert.match(seenSql, /created_at > \$1/);
  assert.match(seenSql, /direction = 'outbound'/);
});

test('spendSince: drops zero and non-numeric rows', async () => {
  const db = fakeDb([
    { model: 'a', cost: '0' },
    { model: 'b', cost: 'not-a-number' },
    { model: 'c', cost: '0.01' },
  ]);
  assert.deepEqual(await spendSince(db, NOW), [{ model: 'c', costUsd: 0.01 }]);
});

// ── the reporter ────────────────────────────────────────────────────────────

test('register: tells the supervisor this agent is up', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
  });
  assert.equal(await hb.register(), true);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:7177/agents/community-agent-01/ready');
  assert.deepEqual(calls[0]?.body, { pid: process.pid });
});

test('beat: reports spend since the watermark', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([{ model: 'claude-opus-5', cost: '0.5' }]),
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
  });
  await hb.beat();
  assert.equal(calls[0]?.url, 'http://127.0.0.1:7177/heartbeat');
  assert.deepEqual(calls[0]?.body, {
    agentId: 'community-agent-01',
    usage: [{ model: 'claude-opus-5', costUsd: 0.5 }],
  });
});

test('beat: omits usage entirely when nothing was spent', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
  });
  await hb.beat();
  // A liveness-only beat, not a fabricated empty usage array.
  assert.deepEqual(calls[0]?.body, { agentId: 'community-agent-01' });
});

test('beat: a rejected report leaves the window open, so nothing is dropped', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([{ model: 'm', cost: '0.25' }]),
    fetchImpl: fakeFetch(calls, false), // supervisor down
    now: () => NOW,
  });
  await hb.beat();
  await hb.beat();
  // Both beats report the same window: the watermark never advanced, so the
  // spend is re-reported rather than lost to a supervisor restart.
  assert.deepEqual(calls[0]?.body, calls[1]?.body);
});

test('beat: a database failure still sends the liveness signal', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const logged: string[] = [];
  const db: Queryable = {
    query: () => Promise.reject(new Error('connection refused')),
  };
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db,
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
    log: (m) => logged.push(m),
  });
  await hb.beat();
  // Beat anyway: bosun must not read a query failure as a dead agent.
  assert.deepEqual(calls[0]?.body, { agentId: 'community-agent-01' });
  assert.match(logged.join(' '), /spend query failed/);
});

test('beat: a network failure never throws into the agent', async () => {
  const logged: string[] = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([]),
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    now: () => NOW,
    log: (m) => logged.push(m),
  });
  // An observability outage must not become a service outage.
  await hb.beat();
  assert.match(logged.join(' '), /heartbeat failed/);
});

test('stop: is idempotent and releases the timer', () => {
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch([]),
    now: () => NOW,
  });
  assert.notEqual(hb.start(), null);
  assert.equal(hb.start(), null, 'a second start must not add a second timer');
  hb.stop();
  hb.stop();
});

// ── the supervisor token ────────────────────────────────────────────────────

test('readFleetHeartbeatConfig: no token on the same box as the supervisor', () => {
  // bosun's operator API is loopback-only and unauthenticated, so an agent
  // beside it needs nothing. Absent must stay absent rather than become ''.
  assert.equal(readFleetHeartbeatConfig(ENV)?.token, undefined);
  assert.equal(readFleetHeartbeatConfig({ ...ENV, FLEET_SUPERVISOR_TOKEN: '   ' })?.token, undefined);
});

test('readFleetHeartbeatConfig: reads and trims the token for a cross-box supervisor', () => {
  const cfg = readFleetHeartbeatConfig({ ...ENV, FLEET_SUPERVISOR_TOKEN: '  s3cret  ' });
  assert.equal(cfg?.token, 's3cret');
});

test('beat: presents the token as a bearer header when one is configured', async () => {
  const calls: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig({ ...ENV, FLEET_SUPERVISOR_TOKEN: 's3cret' })!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
  });
  await hb.beat();
  assert.equal(calls[0]?.headers?.authorization, 'Bearer s3cret');
});

test('beat: sends no authorization header at all when unconfigured', async () => {
  const calls: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
  });
  await hb.beat();
  // An empty bearer would be a token the supervisor has to reject; sending
  // nothing is what an unauthenticated loopback API expects.
  assert.equal(calls[0]?.headers?.authorization, undefined);
});

test('register: carries the token too — it is the first thing a supervisor sees', async () => {
  const calls: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig({ ...ENV, FLEET_SUPERVISOR_TOKEN: 's3cret' })!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch(calls),
    now: () => NOW,
  });
  await hb.register();
  assert.equal(calls[0]?.headers?.authorization, 'Bearer s3cret');
});

test('beat: a 401 says which two things to check, instead of failing silently', async () => {
  // The dangerous failure this module can have: the agent runs perfectly, the
  // spend reads zero, and nothing says why.
  const logged: string[] = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig({ ...ENV, FLEET_SUPERVISOR_TOKEN: 'wrong' })!, {
    db: fakeDb([{ model: 'm', cost: '0.25' }]),
    fetchImpl: fakeFetch([], false, 401),
    now: () => NOW,
    log: (m) => logged.push(m),
  });
  await hb.beat();
  assert.match(logged.join(' '), /401/);
  assert.match(logged.join(' '), /FLEET_SUPERVISOR_TOKEN/);
  assert.match(logged.join(' '), /agentTokenRef/);
});

test('beat: a non-401 refusal is reported with its status', async () => {
  const logged: string[] = [];
  const hb = new FleetHeartbeat(readFleetHeartbeatConfig(ENV)!, {
    db: fakeDb([]),
    fetchImpl: fakeFetch([], false, 503),
    now: () => NOW,
    log: (m) => logged.push(m),
  });
  await hb.beat();
  assert.match(logged.join(' '), /refused \(503\)/);
});
