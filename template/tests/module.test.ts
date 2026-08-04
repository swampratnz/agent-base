// The seed test, so `npm test` has something to run on day one and the gate
// wiring is exercised before you have written anything real. Delete it once
// you have tests of your own.
//
// It is deliberately not a smoke test of `createAgent`: composing an agent
// needs eight registrations this scaffold does not have yet, so that test
// would assert "still incomplete" — true, and worth nothing.
//
// Note the convention the base's own suite follows: a test that pins a
// security invariant is named with a leading `SECURITY:`, and its per-file
// count goes into tests/security-floor.json in the SAME diff.
import assert from 'node:assert/strict';
import test from 'node:test';

import { myAgentModule } from '../src/module/index.js';

test('the module manifest declares a name, which is also its MCP namespace', () => {
  assert.equal(typeof myAgentModule.name, 'string');
  assert.ok(myAgentModule.name.length > 0);
});
