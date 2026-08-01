/**
 * Shared primitive types for the module API.
 *
 * These mirror the shapes proven in `swampratnz/community-agent` (the first
 * consumer). During the Phase 1 strangler refactor over there, THAT repo is
 * authoritative — where the two drift, this file is what gets fixed. See
 * docs/ROADMAP.md.
 */

/**
 * The three-tier RBAC ladder plus the unauthenticated floor. Roles come from
 * env (super admins) + the users table — never from message content. Modules
 * declare tier requirements; the base derives the tool surface and re-asserts
 * tiers inside privileged handlers.
 */
export type Tier = "guest" | "member" | "admin" | "super_admin";

/**
 * Open platform identifier ('discord', 'whatsapp', ...). Deliberately a
 * string, not a closed union: adapters register their platform name at
 * startup, and per-platform behaviour keys off adapter capability
 * declarations, never off hardcoded platform lists.
 */
export type Platform = string;

/** Who is speaking, as resolved by the base (never from message content). */
export interface CallerContext {
  platform: Platform;
  userId: string;
  userName: string;
  conversationId: string;
  role: Tier;
}

/**
 * Turn-scoped key/value bag written by tool handlers and read back by
 * post-turn handlers, only when the turn genuinely succeeded. Replaces
 * hand-typed feature fields on the core reply type.
 */
export type TurnStateBag = Map<string, unknown>;

/** Priority classes for the offline-alert queue (eviction order). */
export type AlertPriority = "system" | "low";

export interface NotifyRequest {
  /** Built-in audiences, or a custom resolver returning user ids per platform. */
  audience:
    "superAdmins" | "admins" | ((platform: Platform) => Promise<string[]>);
  priority: AlertPriority;
  /** Optional sliding-window rate cap shared across call sites. */
  rateKey?: string;
  limitPerHour?: number;
  message: string;
}
