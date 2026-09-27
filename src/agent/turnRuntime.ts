import type { SessionStore, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { CallerContext } from '../auth/rbac.js';
import { ALL_BUILTIN_TOOLS } from './builtinTools.js';

/**
 * Where and with what a turn's Claude Code CLI runs, decided by the module per
 * turn (agent-base gaps G2 and G3, WattoBot containers-design.md §c.5, §i.1).
 *
 * Absent (no resolver registered, or the resolver answers `undefined`), every
 * turn is built exactly as before: the CLI is a local child process, and the
 * full built-in surface exists only inside an armed super-admin window.
 */
export interface TurnRuntime {
  /**
   * G3: the turn's built-in Claude Code tools, replacing the base's own rule
   * (`WebSearch` for admin+, everything for an armed super admin). Names must
   * come from {@link ALL_BUILTIN_TOOLS}; anything else fails the turn closed.
   * An empty list is no built-ins at all.
   */
  builtins?: {
    tools: readonly string[];
    /**
     * Keep the base's arming gate: a `PreToolUse` hook that denies `Bash`,
     * `Write`, `Edit` and `NotebookEdit` unless this actor armed them in this
     * conversation. `false` is for a turn whose tools run somewhere that is
     * itself the containment (a sandbox container), where arming adds nothing.
     */
    armingGate: boolean;
  };
  /** The CLI's working directory. G3 for a local CLI; for a remote one it must match where the CLI really runs, because the SDK keys transcripts by it. */
  cwd?: string;
  /** G2: the whole environment handed to the CLI, instead of the parent's. */
  env?: Record<string, string | undefined>;
  /** G2: start the CLI somewhere else (the SDK's `spawnClaudeCodeProcess`). */
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  /** G2: keep the CLI's transcripts in the parent (the SDK's `sessionStore`, alpha). */
  sessionStore?: SessionStore;
}

/** What the base knows when it asks. */
export interface TurnRuntimeRequest {
  /** The caller, at the tier the turn runs at. */
  readonly caller: CallerContext;
  /** Would the base itself give this turn the full built-in surface (a super admin with a live arming here)? */
  readonly armed: boolean;
}

/**
 * The module's per-turn decision. A throw or a rejection fails the turn, never
 * falls back to the default: a resolver that cannot say where the CLI runs
 * must not have it run on the host.
 */
export type TurnRuntimeResolver = (
  request: TurnRuntimeRequest,
) => TurnRuntime | undefined | Promise<TurnRuntime | undefined>;

let resolver: TurnRuntimeResolver | null = null;

/** Once per process, from the `turnRuntime` manifest field. */
export function registerTurnRuntimeResolver(next: TurnRuntimeResolver): void {
  if (resolver) throw new Error('turn runtime resolver already registered — it cannot be swapped after boot');
  resolver = next;
}

/** Test seam only. */
export function resetTurnRuntimeResolverForTest(): void {
  resolver = null;
}

const KNOWN_BUILTINS: ReadonlySet<string> = new Set(ALL_BUILTIN_TOOLS);

/**
 * The runtime for one turn, validated. `undefined` means the base's defaults.
 * An unknown built-in name throws: a typo must not become a tool the CLI
 * resolves some other way, or silently nothing.
 */
export async function resolveTurnRuntime(request: TurnRuntimeRequest): Promise<TurnRuntime | undefined> {
  if (!resolver) return undefined;
  const runtime = await resolver(request);
  if (runtime?.builtins) {
    const unknown = runtime.builtins.tools.filter((t) => !KNOWN_BUILTINS.has(t));
    if (unknown.length > 0)
      throw new Error(`turn runtime names unknown built-in tools: ${unknown.join(', ')}`);
  }
  return runtime;
}
