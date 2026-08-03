import type { Platform } from './types.js';

/**
 * Minimal transaction-aware query surface, mirroring community-agent's
 * `Queryable` convention: every hook receives the live transaction client so
 * module writes join the base transaction atomically.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * An idempotent SQL fragment contributed by a module. The base migrator
 * concatenates fragments (base core first, then modules in registration
 * order) and executes them as ONE multi-statement query, preserving the
 * all-or-nothing replay property. Fragments follow the conventions proven in
 * community-agent: IF NOT EXISTS everywhere, ADD COLUMN IF NOT EXISTS for
 * evolution, exactly one DROP/ADD pair per named CHECK constraint, and no
 * ALTERing of base-table CHECK lists (extensible enums are registrations).
 */
export interface MigrationFragment {
  /** Stable name for diagnostics; fragments are ordered by registration. */
  name: string;
  sql: string;
}

/**
 * Per-module participation in privacy erasure (forget_me / purge_user_data)
 * and the my_data summary. The base owns the transaction and linked-identity
 * fan-out; each module deletes/anonymizes its own tables and documents its
 * deliberate asymmetries (e.g. a block list that survives erasure) locally.
 */
export interface PurgeContributor {
  purge(platform: Platform, userId: string, tx: Queryable): Promise<number>;
  summarize?(platform: Platform, userId: string, tx: Queryable): Promise<string[]>;
}

/**
 * In-transaction lifecycle hooks fired by base storage operations, so base
 * code never hard-codes knowledge of module tables (and vice versa).
 */
export interface StorageLifecycleHooks {
  /** Fired when interactions are deleted/edited (retraction, retention, purge). */
  onInteractionsDeleted?(ids: readonly number[], tx: Queryable): Promise<void>;
  /** Fired inside removeMember's transaction (access must not outlive membership). */
  onMemberRemoved?(platform: Platform, userId: string, tx: Queryable): Promise<void>;
  /** Fired when a roster row is marked as having left the platform. */
  onRosterLeave?(platform: Platform, userId: string, tx: Queryable): Promise<void>;
}

/**
 * Trust policy for a knowledge-store provenance value. 'quarantined' content
 * is rendered inside untrusted framing and never shortcut-served verbatim;
 * 'trusted' provenance (e.g. first-party docs) may be served directly;
 * 'human-tier' inherits the trust of the authoring role.
 */
export type ProvenanceTrust = 'quarantined' | 'trusted' | 'human-tier';
