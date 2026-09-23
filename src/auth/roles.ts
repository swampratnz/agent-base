import { config } from '../config.js';
import { getMemberRole } from '../storage/repository.js';
import type { Platform } from '../platforms/types.js';
import { atLeast, type Tier } from './tiers.js';

/**
 * A module's organisation-aware narrowing of the deployment seat (WattoBot
 * #204). The base resolves `seat` exactly as it always has (env super admins,
 * then `community_users`, else guest) — a seat is DEPLOYMENT-WIDE, while a
 * consumer with tenants may know the person's standing is narrower (an admin
 * of some customer organisation is not an admin of the operator's guild).
 *
 * It can only NARROW: a returned tier above `seat` is clamped back to `seat`,
 * so the SECURITY.md invariant that tiers derive from storage/env alone still
 * holds, and a buggy override can cost a person privilege but never grant it.
 * A value that is not a tier at all resolves to `guest`. A THROWING override
 * propagates, exactly as a failed `getMemberRole` read does, so every caller's
 * existing fail posture applies unchanged.
 */
export type AuthorityResolver = (who: {
  platform: Platform;
  userId: string;
  seat: Tier;
}) => Tier | Promise<Tier>;

let authorityResolver: AuthorityResolver | null = null;

/**
 * Install the override. Once per process, like every singleton registry:
 * modules reach it through the `AgentModule.resolveAuthority` manifest field.
 */
export function registerAuthorityResolver(resolver: AuthorityResolver): void {
  if (authorityResolver) {
    throw new Error('authority resolver already registered — it cannot be swapped after boot');
  }
  authorityResolver = resolver;
}

const TIERS: readonly Tier[] = ['guest', 'member', 'admin', 'super_admin'];

/**
 * Resolve a user's tier: env-bootstrapped super admins first, then the
 * community_users table, else guest — then narrowed by the registered
 * `AuthorityResolver`, if any. Identity comes from the platform envelope only
 * — never from message content.
 *
 * Every base path that asks "what standing does this person have" comes
 * through here: the router's turn tier (and so `buildQueryOptions`),
 * moderation exemption, the Discord re-mute-on-rejoin skip, and the adapters'
 * command gates. With no resolver registered the result is the seat, unchanged.
 */
export async function resolveRole(platform: Platform, userId: string): Promise<Tier> {
  const seat = await resolveSeat(platform, userId);
  if (!authorityResolver) return seat;
  const narrowed = await authorityResolver({ platform, userId, seat });
  if (!TIERS.includes(narrowed)) return 'guest';
  return atLeast(seat, narrowed) ? narrowed : seat;
}

async function resolveSeat(platform: Platform, userId: string): Promise<Tier> {
  if (isSuperAdmin(platform, userId)) return 'super_admin';
  const stored = await getMemberRole(platform, userId);
  return stored ?? 'guest';
}

/**
 * Admins and super admins are exempt from auto-moderation (never warned or
 * muted). The one predicate both `Moderator.scan` and the Discord adapter's
 * re-mute-on-rejoin check use, so the two cannot disagree about who is exempt.
 */
export async function isModerationExempt(platform: Platform, userId: string): Promise<boolean> {
  return atLeast(await resolveRole(platform, userId), 'admin');
}

export function isSuperAdmin(platform: Platform, userId: string): boolean {
  return platform === 'discord'
    ? config.rbac.superAdminDiscordIds.includes(userId)
    : config.rbac.superAdminWhatsappNumbers.includes(userId);
}

/** All configured super-admin user ids for a platform (for alerting). */
export function superAdminIds(platform: Platform): readonly string[] {
  return platform === 'discord' ? config.rbac.superAdminDiscordIds : config.rbac.superAdminWhatsappNumbers;
}
