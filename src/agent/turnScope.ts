import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which kind of turn the code running right now belongs to (agent-base
 * background turns, docs/design/background-subagents.md).
 *
 * A LEAF module on purpose: `pendingActions.ts` reads it, and the turn engine
 * that sets it imports half the runtime, so the two must not import each
 * other.
 *
 * The scope is entered by the base's own tool-server wrapper around every
 * module tool handler of a background turn (toolServer.ts). It follows the
 * handler through every `await`, so a primitive that must never run unattended
 * can refuse even when a module reaches it some way other than through the
 * tool context the base hands it: a helper that captured its own
 * `requireConfirm` closure, or a direct import of `registerPendingAction`.
 */
export type TurnKind = 'live' | 'background';

/** What a turn knows about itself, as told to `makeContext` and the turn-runtime resolver. */
export type TurnInfo =
  { readonly kind: 'live' } | { readonly kind: 'background'; readonly id: string; readonly tag: unknown };

const scope = new AsyncLocalStorage<{ kind: 'background'; id: string }>();

/** Run `fn` as part of background turn `id`. */
export function runInBackgroundScope<T>(id: string, fn: () => T): T {
  return scope.run({ kind: 'background', id }, fn);
}

/** The background turn the current code runs for, or `null` outside one. */
export function currentBackgroundTurnId(): string | null {
  return scope.getStore()?.id ?? null;
}
