import { config } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * A module's answer to "may this Discord guild be heard?" (agent-base #65),
 * registered once through `AgentModule.admitGuild`. It is consulted only for a
 * guild OTHER than the configured `DISCORD_GUILD_ID`, which is always admitted
 * without asking, so the home guild's hot path never waits on it.
 *
 * Only a literal `true` admits. A throw, a rejection, or any other value
 * admits nothing (fail closed), and is logged.
 *
 * The base does not cache the answer. The module owns both halves of a claim
 * (it writes the claim and it writes the release), so it is the only party
 * that can invalidate a cache correctly; a base-side TTL would make a release
 * lag by that TTL, which for a released customer server means the bot keeps
 * hearing it. A module whose answer is a database read should cache inside
 * the hook, next to the writes that invalidate it.
 */
export type GuildAdmitter = (guildId: string) => boolean | Promise<boolean>;

let admitter: GuildAdmitter | null = null;

/** Install the hook. Once per process, like every singleton registry. */
export function registerGuildAdmitter(hook: GuildAdmitter): void {
  if (admitter) {
    throw new Error('guild admitter already registered — it cannot be swapped after boot');
  }
  admitter = hook;
}

/** True when a module registered `admitGuild`. Absent, the adapter is single-guild exactly as before. */
export function hasGuildAdmitter(): boolean {
  return admitter !== null;
}

/**
 * The configured guild, and only it. The check every HOME-scoped behaviour
 * uses: the roster, auto-enroll, the welcome, the rejoin re-mute, auto
 * moderation, the membership-scope cache and `canPostTo`. Those all act on,
 * or derive from, the configured guild (they fetch it by id), so running them
 * for another guild's event would apply the operator's community to a
 * stranger's server — auto-enroll above all, which grants a
 * deployment-wide member seat.
 */
export function isHomeGuild(guildId: string | null | undefined): boolean {
  return guildId === config.discord.guildId;
}

/**
 * THE admission predicate: may a message, edit, delete or slash command from
 * this guild be heard at all? The home guild always; any other guild only
 * when the registered hook answers exactly `true`. With no hook registered
 * this is `isHomeGuild`, so a single-guild deployment behaves as it always
 * has.
 */
export async function admitsGuild(guildId: string | null | undefined): Promise<boolean> {
  if (guildId == null) return false;
  if (isHomeGuild(guildId)) return true;
  if (!admitter) return false;
  try {
    return (await admitter(guildId)) === true;
  } catch (err) {
    logger.error({ err, guildId }, 'Guild admission hook failed; treating the guild as not admitted');
    return false;
  }
}
