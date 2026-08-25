import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure pins for the router's pre-turn security spine
// (src/routerIntercepts.ts). The file's runtime surface is a leaf — its only
// imports are type-only and erase — so no dummy env is needed here.
//
// This file exists for the same reason as rbac.test.ts (issue #9's shape):
// routerIntercepts.ts documents that "the SECURITY: chain test pins the exact
// order", but that test stayed behind in community-agent when the spine was
// extracted. What base owns — and what a second consumer inherits with no
// safety net of its own — is the ORDER itself and the fact that registration
// can never touch it. Both are pinned here against the package boundary.
import {
  PRE_TURN_SPINE,
  registerPreTurnIntercept,
  registeredPreTurnIntercepts,
} from '../src/routerIntercepts.js';

test('SECURITY: PRE_TURN_SPINE runs in exactly the audited order — CONFIRM before the addressed gate, pause before rate-limit, budget after both', () => {
  // The relative order is load-bearing (see routerIntercepts.ts's header):
  // a bare "CONFIRM" must work in groups, a paused user must never see the
  // rate-limit notice too, and a shed message must never pay a budget read.
  // Any reordering, insertion, or removal must fail this exact-list pin.
  assert.deepEqual(
    [...PRE_TURN_SPINE],
    [
      'block-list',
      'role-resolution',
      'gated-guest',
      'record-inbound',
      'confirm-intercept',
      'escalation-confirm',
      'addressed-gate',
      'pause',
      'rate-limit',
      'daily-budget',
      'auto-answer-reserve',
      'memory-barrier',
      'auto-answer-thread',
    ],
  );
});

test('SECURITY: PRE_TURN_SPINE is frozen — no runtime mutation can insert, remove, or reorder a spine step', () => {
  assert.ok(Object.isFrozen(PRE_TURN_SPINE), 'the spine array must be frozen');
  const mutable = PRE_TURN_SPINE as unknown as string[];
  // ESM is strict mode, so writes to a frozen array throw rather than
  // silently no-op — both the append and the in-place reorder must reject.
  assert.throws(() => mutable.push('rogue-step'));
  assert.throws(() => {
    mutable[0] = 'rogue-step';
  });
  assert.equal(PRE_TURN_SPINE[0], 'block-list');
  assert.equal(PRE_TURN_SPINE.length, 13);
});

test('SECURITY: every spine step name is rejected by registration — an intercept can never shadow or displace a spine step', () => {
  for (const name of PRE_TURN_SPINE) {
    assert.throws(
      () => registerPreTurnIntercept({ name, run: async () => 'continue' as const }),
      /collides with a security-spine step/,
      `registering '${name}' must be rejected as a spine collision`,
    );
  }
  // And none of the rejected attempts leaked into the post-spine region.
  const spineNames: readonly string[] = PRE_TURN_SPINE;
  assert.equal(
    registeredPreTurnIntercepts().some((intercept) => spineNames.includes(intercept.name)),
    false,
    'a rejected spine-name registration must not appear among the post-spine intercepts',
  );
});
