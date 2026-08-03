import type { ProvenanceTrust } from './storage.js';

/**
 * A document source for the knowledge-store ingest pipeline (llms.txt-style
 * index → same-origin fetch → H2 chunking → content-diff upsert). The trust
 * level is a per-source POLICY decision that flows into retrieval-time
 * handling; it is registered in module CODE, never derived from env or
 * message content.
 */
export interface IngestSource {
  name: string;
  indexUrl: string;
  excludePaths?: readonly string[];
  pathPrefixStrips?: readonly string[];
  provenance: string;
  trust: ProvenanceTrust;
}

/**
 * A fixed research topic for the scheduled web-refresh job. The topic list is
 * module code, not env — the researchable surface must not be
 * runtime-controllable. Refreshed entries land quarantined (provenance
 * registered by the module, typically 'auto').
 */
export interface RefreshTopic {
  title: string;
  query: string;
}

/**
 * A section of a periodic digest (admin- or member-facing). The base owns the
 * gather loop, quiet-period skip, freshness guard, trend persistence, and the
 * counts/scrubbed-text-only contract; modules register sections/signals.
 */
export interface DigestSignal {
  key: string;
  fetch(ctx: {
    scopeConversationIds: readonly string[];
    sinceIso: string;
  }): Promise<number | readonly string[]>;
  /** Return null to omit the line when there is nothing to report. */
  renderLine(value: number | readonly string[], trendSuffix: string): string | null;
  trend?: 'count' | 'pct';
}

/** A pending-work queue surfaced in review_queue / my_submissions rollups. */
export interface QueueProvider {
  key: string;
  label: string;
  countOpen(viewerScope: readonly string[]): Promise<number>;
  oldestAgeDays?(viewerScope: readonly string[]): Promise<number | null>;
}

/**
 * Agent Skills shipped by a module: a code-reviewed local directory plus an
 * explicit allowlist. The base concatenates manifests and enforces the
 * never-'all' invariant.
 */
export interface SkillsManifest {
  skillsDir: string;
  enabledSkills: readonly string[];
}
