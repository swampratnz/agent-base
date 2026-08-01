import type { CallerContext, Platform, TurnStateBag } from "./types.js";

/**
 * A background job registered by a module. The base owns the scheduler:
 * tracked runs, re-entrancy latch, consecutive-failure alerting, cost
 * recording, and the single shutdown sweep.
 */
export interface JobSpec {
  /** Open string (no closed union) — must be unique across registered modules. */
  name: string;
  enabled(moduleConfig: unknown): boolean;
  intervalMs: number;
  /** Throw only on total failure; partial progress should be handled inside. */
  runOnce(): Promise<void>;
}

/**
 * Pre-turn intercepts run at named stages of the router pipeline. The
 * security-ordered spine (block → role → gate → CONFIRM → pause → rate →
 * budget → serialized turn) is fixed by the base and cannot be reordered or
 * removed by modules; intercepts slot only into the declared stages.
 */
export type InterceptStage = "afterGate" | "beforeTurn";

export interface PreTurnIntercept {
  stage: InterceptStage;
  /** Return a reply to short-circuit the turn, or null to continue. */
  handle(
    message: IncomingMessageView,
    caller: CallerContext,
  ): Promise<string | null>;
}

/** Read-only view of the normalized inbound message given to intercepts. */
export interface IncomingMessageView {
  platform: Platform;
  conversationId: string;
  userId: string;
  userName: string;
  text: string;
  isDirect: boolean;
}

/**
 * Post-turn observers, invoked by the router after a successful send with the
 * turn-state bag tools wrote during the turn. This replaces feature-specific
 * fields on the core reply type.
 */
export type PostTurnHandler = (
  outcome: { ok: boolean; text: string; turnState: TurnStateBag },
  message: IncomingMessageView,
) => Promise<void>;

/**
 * A zero-model-call command surfaced natively per platform: mapped to a slash
 * command where the adapter supports registration, and to the router's
 * text-command intercept elsewhere.
 */
export interface CommandDef {
  name: string;
  description: string;
  platforms?: readonly Platform[];
  handler(args: string, caller: CallerContext): Promise<string>;
}
