import type { Platform } from '../platforms/types.js';

/**
 * The Agent SDK's built-in tool surface, and the arming window that gates its
 * MUTATING half for super admins (issue community-agent#1405 follow-up).
 *
 * Until now the base granted exactly one built-in (WebSearch, admin+) and
 * disallowed `Task`/`WebFetch` for every tier — see docs/SECURITY.md §1. The
 * owner asked for super admins to have the full built-in surface in every
 * conversation. That is a deliberate, documented posture change, not a
 * loosening by accident, and it comes with one hard constraint:
 *
 * `Bash`/`Write`/`Edit`/`NotebookEdit` execute on the HOST running this
 * process, as the service account. In a group conversation, other members'
 * messages are untrusted content in the same model context (recalled history,
 * the rollover tail, fetched pages, images). So a granted-and-auto-approved
 * shell is reachable by injection: "run this" in a group, answered inside a
 * super admin's turn, would execute with that super admin's authority.
 *
 * The arming window is the mitigation: the full surface is granted only while
 * the actor has armed it with a fresh platform message, and an unarmed
 * super-admin turn carries the pre-change surface (`['WebSearch']`, with
 * `Task`/`WebFetch` disallowed). Same trust property the CONFIRM flow has
 * (`pendingActions.ts`): the model can ASK to be armed and can never arm
 * itself, because arming is classified in the router before the model runs
 * and is keyed to the actor's own id.
 *
 * What the window does NOT bound: consequences. One armed `Bash`/`Write` call
 * can rewrite the deployed `dist/` or the CLI config dir under the service
 * account, which survives the window closing, a disarm, and a restart. The
 * TTL bounds WHEN an injection can strike, not how long the damage lasts.
 *
 * Why an arming WINDOW rather than a confirmation per call: the router
 * serialises work per conversation (`Router.enqueue`), so a turn that blocked
 * inside `canUseTool` awaiting a CONFIRM message would be waiting on a message
 * queued behind itself. A window is the only shape that survives that.
 */

/**
 * Built-ins that do not change the host. "Non-mutating" is NOT "safe":
 * `Read`/`Glob`/`Grep` read anything the service account can read, `WebFetch`
 * composes its own URL (the base disallows it below super admin for exactly
 * that reason — it is an egress channel the outbound secret redaction never
 * sees), and `Task` starts a sub-agent whose prompt can be attacker-chosen
 * text, equipped with this same set, returning output that looks like a
 * trusted tool result. So this set is granted only inside an armed window
 * too — see `ALL_BUILTIN_TOOLS`' note.
 */
export const NON_MUTATING_BUILTIN_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
]);

/**
 * Built-ins that change the host (or run arbitrary code on it). A
 * `PreToolUse` hook re-checks the arming window for these even inside an
 * armed turn, because the window can expire mid-turn while the options object
 * was built once at the start (`allowedTools` pre-approval cannot gate
 * anything, so a hook is the only thing guaranteed to fire — the same reason
 * WebSearch's rate limit is a hook, see core.ts).
 */
export const MUTATING_BUILTIN_TOOLS = Object.freeze(['Bash', 'Write', 'Edit', 'NotebookEdit']);

/**
 * The full built-in surface, granted ONLY to a super admin inside an armed
 * window (`core.ts`'s `fullBuiltins`). An unarmed super-admin turn gets the
 * pre-change surface instead: `['WebSearch']`, with `Task`/`WebFetch`
 * disallowed, identical to an admin turn.
 *
 * Gating the GRANT rather than only the mutating half is the correction that
 * came out of review: gating only `Bash`/`Write`/`Edit`/`NotebookEdit` left
 * `Read` + `WebFetch` granted and auto-approved in every super-admin turn,
 * which is a complete read-anything-then-send-anywhere path reachable by
 * injected text in a group conversation, with no arming and no audit line.
 */
export const ALL_BUILTIN_TOOLS = Object.freeze([...NON_MUTATING_BUILTIN_TOOLS, ...MUTATING_BUILTIN_TOOLS]);

/** How long one arming lasts. Short: an armed window is standing shell access. */
export const SHELL_ARM_TTL_MS = 5 * 60_000;

const armed = new Map<string, number>();

function key(platform: Platform, conversationId: string, actorUserId: string): string {
  return `${platform}:${conversationId}:${actorUserId}`;
}

/**
 * Arm the mutating built-ins for this actor in this conversation. Called ONLY
 * from the router's deterministic intercept, never from a tool handler, so an
 * injected turn cannot arm itself.
 */
export function armMutatingTools(platform: Platform, conversationId: string, actorUserId: string): void {
  armed.set(key(platform, conversationId, actorUserId), Date.now() + SHELL_ARM_TTL_MS);
}

/** Drop an arming early. Returns whether one was live. */
export function disarmMutatingTools(
  platform: Platform,
  conversationId: string,
  actorUserId: string,
): boolean {
  const k = key(platform, conversationId, actorUserId);
  const expiry = armed.get(k);
  armed.delete(k);
  return expiry !== undefined && expiry > Date.now();
}

/** Whether this actor currently has a live arming in this conversation. */
export function isMutatingArmed(platform: Platform, conversationId: string, actorUserId: string): boolean {
  const expiry = armed.get(key(platform, conversationId, actorUserId));
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    armed.delete(key(platform, conversationId, actorUserId));
    return false;
  }
  return true;
}

/** Seconds left on a live arming, or 0. For the router's acknowledgement text. */
export function armedSecondsRemaining(
  platform: Platform,
  conversationId: string,
  actorUserId: string,
): number {
  const expiry = armed.get(key(platform, conversationId, actorUserId));
  if (expiry === undefined) return 0;
  return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
}

/** Drop expired entries so abandoned armings don't accumulate. */
export function sweepExpiredArmings(): void {
  const now = Date.now();
  for (const [k, expiry] of armed) if (expiry <= now) armed.delete(k);
}

/** Test seam only: forget every arming. */
export function resetArmingsForTest(): void {
  armed.clear();
}

/**
 * Classify an arming instruction in a platform message. Deliberately exact
 * (after trimming and dropping leading @-mention tokens, the same tolerance
 * `classifyConfirmReply` applies): an arming phrase must be typed on purpose,
 * never matched loosely out of ordinary conversation.
 */
export function classifyArmingReply(text: string): 'arm' | 'disarm' | null {
  const stripped = text
    .trim()
    .replace(/^(?:<@!?\d+>|@[\w.+-]+|\s)+/u, '')
    .trim()
    .toLowerCase();
  if (stripped === 'arm shell') return 'arm';
  if (stripped === 'disarm shell') return 'disarm';
  return null;
}
