import { test } from 'node:test';
import assert from 'node:assert/strict';

// migrate.ts transitively loads the storage boot config, which validates env
// at import time. No database is touched: every case injects its own query().
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { applySchemaSql } = await import('../src/storage/migrate.js');

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const noSleep = async () => {};

test('a schema apply that loses a deadlock is retried until it succeeds', async () => {
  let calls = 0;
  await applySchemaSql('SELECT 1', {
    query: async () => {
      calls += 1;
      if (calls < 3) throw deadlock();
    },
    sleep: noSleep,
  });
  assert.equal(calls, 3, 'two deadlocks, then the replay goes through');
});

test('any other error is thrown at once and never retried', async () => {
  let calls = 0;
  await assert.rejects(
    applySchemaSql('SELECT 1', {
      query: async () => {
        calls += 1;
        throw Object.assign(new Error('syntax error at or near "CREAT"'), { code: '42601' });
      },
      sleep: noSleep,
    }),
    /syntax error/,
  );
  assert.equal(calls, 1, 'a real schema error must fail the migration immediately');
});

test('the retry budget is finite: after the last attempt the deadlock is rethrown', async () => {
  let calls = 0;
  await assert.rejects(
    applySchemaSql('SELECT 1', {
      query: async () => {
        calls += 1;
        throw deadlock();
      },
      attempts: 4,
      sleep: noSleep,
    }),
    (err: unknown) => (err as { code?: string }).code === '40P01',
  );
  assert.equal(calls, 4);
});

test('the backoff grows between attempts', async () => {
  const delays: number[] = [];
  let calls = 0;
  await applySchemaSql('SELECT 1', {
    query: async () => {
      calls += 1;
      if (calls < 4) throw deadlock();
    },
    baseDelayMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(delays.length, 3);
  assert.ok(delays[0] >= 100 && delays[0] < 200, `first wait ${delays[0]}`);
  assert.ok(delays[1] >= 200 && delays[1] < 300, `second wait ${delays[1]}`);
  assert.ok(delays[2] >= 400 && delays[2] < 500, `third wait ${delays[2]}`);
});
