import type { Platform } from './types.js';

/**
 * Adapter registration: base config names the enabled adapters; each factory
 * constructs one. The PlatformAdapter contract itself ships with the base
 * runtime when it is extracted (Phase 3) — until then see
 * community-agent's src/platforms/types.ts, which is the authoritative shape.
 */
export interface AdapterFactory {
  platform: Platform;
  create(adapterConfig: unknown): unknown;
}

/**
 * Deployment-specific text an adapter renders at its own edges. Returned as
 * plain strings that the base still runs through the outbound filter — a
 * module can supply copy, never bypass filtering.
 */
export interface AdapterTextPack {
  welcomeMessage?: string;
  welcomeMessageOpenMode?: string;
  warnDmPrefix?: string;
  voiceTranscriptionCaveat?: string;
  /** Extra per-language variants keyed by declared language codes. */
  variants?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Inbound-content policy hook (moderation, compliance screening, PII rules).
 * The base runs it on every inbound message before the agent turn; effectors
 * (notify channels, per-user counters, platform enforcement) are provided by
 * the base/adapters. The engine is base; the policy is the module's.
 */
export interface InboundContentPolicy {
  scan(input: {
    platform: Platform;
    conversationId: string;
    userId: string;
    text: string;
    authorTier: string;
  }): Promise<
    | { verdict: 'allow' }
    | { verdict: 'flag'; reason: string }
    | { verdict: 'act'; action: string; reason: string }
  >;
}
