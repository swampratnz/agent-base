import type { z } from 'zod';
import type { CallerContext, NotifyRequest, Platform, Tier, TurnStateBag } from './types.js';

/**
 * The tool-hosting kernel the base exposes to every registered tool handler.
 * These are the five security helpers (plus plumbing) that today live as
 * closures inside community-agent's buildToolServer(); modules use them and
 * can never bypass them.
 */
export interface ToolContext {
  caller: CallerContext;
  /** Send-capable handle for the caller's platform (send paths are filtered). */
  adapterFor(platform: Platform): unknown;
  /** Conversation ids the caller may read; admin SQL reads must be scoped to it. */
  callerScope(): Promise<string[]>;
  /**
   * Wrap a privileged mutation: writes an audit row and echoes to super
   * admins. `actionKind` should be registered via AgentModule.auditActionKinds.
   */
  audited(actionKind: string, params: Record<string, unknown>, run: () => Promise<string>): Promise<string>;
  /**
   * Register a destructive action for the router-side CONFIRM flow instead of
   * executing it. The tier is re-asserted at confirm time; the description is
   * sanitized once by the base.
   */
  requireConfirm(spec: { description: string; minTier: Tier; execute(): Promise<string> }): string;
  notify(req: NotifyRequest): Promise<void>;
  turnState: TurnStateBag;
}

/**
 * Declarative tool registration. One definition is the single source for the
 * tier surface, platform filtering, feature-flag filtering, confirm gating,
 * audit wiring, and the capability rundown — replacing the four hand-synced
 * places a tool lives in today (tool closure, rbac tier arrays, feature-flag
 * drop table, capabilities prose).
 */
export interface ToolDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Tool name WITHOUT the MCP prefix; the base namespaces it per module. */
  name: string;
  description: string;
  /** Minimum tier: selects the per-turn surface AND is re-asserted in-handler. */
  minTier: Tier;
  /** Restrict to platforms whose adapters declare the needed capability. */
  platforms?: readonly Platform[];
  /** Config-derived predicate; evaluated at init, never at import time. */
  featureFlag?: (moduleConfig: unknown) => boolean;
  /** Marks the tool side-effect-free for SDK annotations. */
  readOnly?: boolean;
  /** One-line, tier-scoped entry for the registry-generated capability rundown. */
  capabilityLine: string;
  /** Optional sliding-window rate cap enforced by the base. */
  rateLimit?: { key: string; windowMs: number; cap: number };
  schema: Schema;
  handler(args: z.infer<Schema>, ctx: ToolContext): Promise<string>;
}
