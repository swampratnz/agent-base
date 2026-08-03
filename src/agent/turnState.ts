/**
 * Generic per-turn state plumbing (module API `intercepts` +
 * `postTurnHandlers`): base owns the MECHANISM — a module-augmentable
 * scratch interface, the reply-facing bag, and a finalizer registry —
 * while a module declares and documents the keys ITS tools write, in one
 * file, and registers the finalizer that maps scratch to bag.
 */
import type { CrossedKnowledgeGapCluster } from '../storage/repository.js';

/**
 * Turn-scoped, mutable scratch state threaded into `buildToolServer` by
 * `execTurn` (originating in issue #411) — tool handlers write into it
 * during the turn. Base declares it EMPTY; modules add their keys via
 * `declare module` augmentation (all keys optional, so `execTurn`'s `{}`
 * initializer stays module-agnostic).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ToolServerTurnState {}

/**
 * The read-only bag a finished turn surfaces as `AgentReply.turnState` —
 * only ever populated on a genuine success (`TurnOutcome.ok === true`),
 * preserving the old fields' "never set on a fallback/error reply"
 * contract. Same augmentation pattern as `ToolServerTurnState`, and modules
 * add keys of their own the same way.
 *
 * The keys below are the ones BASE ITSELF reads: the router ships post-turn
 * handlers for admin escalation, knowledge-gap alerting, stale-knowledge
 * alerting and knowledge-hit correlation, so base has to be able to name
 * them. Every one stays optional and absent-not-zero — a module that writes
 * none of them (no rating tool, no knowledge search tool) simply never fires
 * those handlers. WRITING them is a module's job: base ships no tool
 * handlers at all, only the readers.
 */
export interface TurnStateBag {
  /**
   * Best-effort correlation with the most recent qualifying knowledge-search
   * hit — a correlation, not a guarantee: it names the last qualifying call
   * in the turn, not necessarily the entry the model's final reply drew
   * from. The router's outbound recording stamps it into the same
   * `meta.knowledgeEntryId` key the deterministic knowledge-shortcut path
   * writes, so both paths feed the answer-feedback queries unchanged.
   */
  knowledgeEntryId?: number;
  /** `true` only for a genuine thumbs-down recorded this turn — read by the router's escalation handler. */
  unhelpfulAnswerRated?: boolean;
  /** `true` only for a genuine human-help ask this turn — read by the router's escalation handler. */
  humanHelpRequested?: boolean;
  /** First-crossing knowledge-gap cluster — read by the router's gap-alert handler. */
  knowledgeGapCluster?: CrossedKnowledgeGapCluster;
  /** Newly-stale served entry ids — read by the router's stale-knowledge handler. */
  staleKnowledgeAlertIds?: number[];
}

/**
 * Maps the raw tool-server scratch state to the keys this module wants to
 * surface on the reply — the module-owned half of what used to be the five
 * hardcoded conditional spreads at the bottom of `execTurn`.
 */
export type TurnStateFinalizer = (turnState: ToolServerTurnState) => Partial<TurnStateBag>;

const finalizers: TurnStateFinalizer[] = [];

/** Register a module's finalizer — called once at module load (communityTurnState.ts). */
export function registerTurnStateFinalizer(finalizer: TurnStateFinalizer): void {
  finalizers.push(finalizer);
}

/**
 * Run every registered finalizer over the turn's scratch state and merge the
 * results. Called by `execTurn` on the genuine-success path ONLY — so a key
 * can never ride a fallback/error reply, exactly like the fields it
 * replaces.
 */
export function finalizeTurnState(turnState: ToolServerTurnState): Partial<TurnStateBag> {
  const bag: Partial<TurnStateBag> = {};
  for (const finalizer of finalizers) Object.assign(bag, finalizer(turnState));
  return bag;
}
