import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// Stop (WattoBot #257): a module hands `execTurn` an AbortSignal, and when it
// fires the running model call must end, the turn must resolve with the cost
// the CLI reported, and nothing may be answered on the stopped turn's behalf.
// The SDK is mocked so the interrupt handshake is proven against the stream
// shape without a paid call: `interrupt()` is what makes the CLI end the turn
// and emit its `result`, and the abortController is the backstop for a CLI
// that never does.

const realSdk = await import('@anthropic-ai/claude-agent-sdk');
type Msg = Record<string, unknown>;

interface Call {
  prompt: unknown;
  abortController: AbortController;
  interrupts: number;
}
let calls: Call[] = [];
// How the mocked CLI answers an interrupt: with its result, or not at all.
let answersInterrupt = true;
let midFlight: () => void = () => {};

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...realSdk,
    query: (args: { prompt: unknown; options: { abortController: AbortController } }) => {
      const call: Call = {
        prompt: args.prompt,
        abortController: args.options.abortController,
        interrupts: 0,
      };
      calls.push(call);
      let interrupted: () => void = () => {};
      const interruptedP = new Promise<void>((resolve) => (interrupted = resolve));
      const aborted = new Promise<never>((_r, reject) =>
        call.abortController.signal.addEventListener('abort', () => reject(new Error('aborted by user'))),
      );
      aborted.catch(() => {});
      const stream = (async function* () {
        yield init;
        // The model call is running: the test fires Stop now.
        midFlight();
        await Promise.race([interruptedP, aborted]);
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 's1',
          total_cost_usd: 0.0123,
          usage: { cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
        };
      })();
      return Object.assign(stream, {
        interrupt: async () => {
          call.interrupts += 1;
          if (answersInterrupt) interrupted();
          return undefined;
        },
      });
    },
  },
});

const { registerToolTiers } = await import('../src/auth/rbac.js');
const { registerNoticePack } = await import('../src/strings/catalogue.js');
const { TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES } = await import('./fixtures/noticePack.js');
const { registerFlaggedToolPredicates } = await import('../src/agent/featureFlags.js');
const { registerToolServerParts } = await import('../src/agent/toolServer.js');
const { execTurn, STOP_GRACE_MS } = await import('../src/agent/core.js');
import type { PlatformAdapter } from '../src/platforms/types.js';
import type { CallerContext } from '../src/auth/rbac.js';

registerToolTiers({ member: [], admin: [], superAdmin: [], discordOnly: [] });
registerFlaggedToolPredicates([]);
registerNoticePack(TEST_NOTICE_AXES, TEST_NOTICE_ENTRIES);
registerToolServerParts({ name: 't', makeContext: () => ({}), registry: [] });

const init: Msg = { type: 'system', subtype: 'init', session_id: 's1', tools: [], mcp_servers: [] };
const caller = { platform: 'discord', userId: 'u1', conversationId: 'c1', role: 'member' } as CallerContext;
const adapter = {} as PlatformAdapter;

function reset(answer: boolean): AbortController {
  calls = [];
  answersInterrupt = answer;
  const stop = new AbortController();
  midFlight = () => stop.abort();
  return stop;
}

test('Stop mid-flight interrupts the model call and resolves with the cost the CLI reported', async () => {
  const stop = reset(true);
  const started = Date.now();
  const outcome = await execTurn(
    caller,
    'draft the roster',
    'system prompt',
    adapter,
    null,
    undefined,
    undefined,
    stop.signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].interrupts, 1, 'the running call is interrupted, not left to finish');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.text, '', 'a stopped turn answers nothing on the module’s behalf');
  assert.equal(outcome.fallbackNoticeId, undefined, 'and serves no fallback notice');
  assert.equal(outcome.resumeFailed, false);
  assert.equal(outcome.costUsd, 0.0123, 'what was spent is reported');
  assert.equal(outcome.cacheReadTokens, 5);
  assert.equal(outcome.sessionId, 's1', 'the session survives, so the conversation carries on');
  assert.equal(calls[0].abortController.signal.aborted, false, 'a graceful interrupt needs no backstop');
  assert.ok(Date.now() - started < STOP_GRACE_MS, 'the turn ends as soon as the CLI answers');
  assert.notEqual(typeof calls[0].prompt, 'string', 'a signalled turn runs in streaming-input mode');
});

test('a CLI that ignores the interrupt is aborted after the grace window, and the turn still stops', async () => {
  const stop = reset(false);
  const started = Date.now();
  const outcome = await execTurn(
    caller,
    'draft the roster',
    'system prompt',
    adapter,
    null,
    undefined,
    undefined,
    stop.signal,
  );
  const elapsed = Date.now() - started;
  assert.equal(calls[0].interrupts, 1);
  assert.equal(calls[0].abortController.signal.aborted, true, 'the backstop aborts the query');
  assert.ok(elapsed >= STOP_GRACE_MS - 50, `waited the grace window (${elapsed}ms)`);
  assert.ok(elapsed < STOP_GRACE_MS + 2000, `and not much longer (${elapsed}ms)`);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.text, '');
  assert.equal(outcome.fallbackNoticeId, undefined);
  assert.equal(outcome.costUsd, undefined, 'no result arrived, so no cost is invented');
});

test('a signal that has already fired makes no model call at all', async () => {
  const stop = reset(true);
  stop.abort();
  const outcome = await execTurn(
    caller,
    'draft the roster',
    'system prompt',
    adapter,
    null,
    undefined,
    undefined,
    stop.signal,
  );
  assert.equal(calls.length, 0, 'nothing is spent');
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.text, '');
});

test('a turn without a signal keeps the plain-string prompt and is never interrupted', async () => {
  reset(true);
  const pending = execTurn(caller, 'hello', 'system prompt', adapter, null);
  await new Promise((r) => setImmediate(r));
  const running = calls[0];
  assert.equal(typeof running.prompt, 'string', 'byte-identical to before for an ordinary turn');
  // End the mocked call from outside, as the turn timeout would.
  running.abortController.abort();
  const outcome = await pending;
  assert.equal(running.interrupts, 0);
  assert.equal(outcome.stopped, undefined, 'only a module signal reads as a Stop');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallbackNoticeId, 'internalErrorReply');
});
