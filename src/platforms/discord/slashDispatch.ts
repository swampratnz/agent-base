import { MessageFlags, type Client, type Interaction } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { registeredCommands, type SlashCommandDeps } from '../../commands/registry.js';
import { resolveRole } from '../../auth/roles.js';
import type { Tier } from '../../auth/tiers.js';
import { isUserBlocked } from '../../storage/repository.js';
import { isPaused } from '../../storage/policyStore.js';
import { notice } from '../../strings/catalogue.js';

/**
 * The Discord slash-command MECHANISM (agent-base plan §Phase-2 Stage 4):
 * registration and dispatch, driven entirely by whatever command list was
 * registered into `commands/registry.ts`. No command content lives here —
 * the handlers and their registration JSON are the module's, bound onto
 * their registry entries with `bindDiscordCommand`, which is what lets the
 * adapter own the two Discord-client hooks below without importing a single
 * module command.
 *
 * ⚠️ **Bind AFTER `createAgent`, never at module scope.** `bindDiscordCommand`
 * reads the registered command list, and `createAgent` registers that list
 * from the manifest during its singleton phase — which runs when the
 * composition root's BODY executes, long after every module in its static
 * import graph has been evaluated. So a `bindDiscordCommand` call at a
 * module's own import time always runs BEFORE registration and throws
 * `registeredCommands: no command list registered`, killing the process at
 * startup. Export a `bind*()` function and call it from somewhere the
 * composition root reaches after `createAgent` returns — building the
 * adapters is the natural place, since nothing can dispatch a slash command
 * before an adapter exists. Make it idempotent (a `bound` latch): tests build
 * adapters more than once per process, and `bindDiscordCommand` rejects a
 * duplicate name.
 *
 * (Under the pre-`createAgent` side-effect composition, module-scope binding
 * happened to work because the composition root imported the commands module
 * early. The flip to `createAgent` inverted that order — see
 * community-agent#961, which is the startup crash this note exists to
 * prevent recurring.)
 */

/**
 * Every registered command's Discord registration JSON, in registry order —
 * the exact order this function has always returned. A command with no
 * Discord half bound is skipped, so an unimported (or platform-absent)
 * command surface simply registers nothing.
 */
export function buildSlashCommands() {
  return registeredCommands().flatMap((command) => (command.discord ? [command.discord.build()] : []));
}

/**
 * Guild-scoped registration on `ClientReady` (never global — this deployment
 * is single-guild, and global registration propagates over up to an hour and
 * widens exposure to any guild the bot token might ever join). Fire-and-
 * forget, same shape as `backfillRoster`/`reconcileMutedRole`: a registration
 * failure must never block message handling.
 */
export async function registerSlashCommands(client: Client): Promise<void> {
  try {
    if (!client.application) {
      logger.warn('Slash command registration skipped: client.application unavailable');
      return;
    }
    await client.application.commands.set(buildSlashCommands(), config.discord.guildId);
    logger.info('Discord slash commands registered');
  } catch (err) {
    logger.warn({ err }, 'Slash command registration failed');
  }
}

/**
 * SECURITY: the reads the dispatch gates below run against — injectable so the
 * gates are testable without a database, defaulting to the same functions the
 * router's spine steps call. Production callers never pass this.
 */
export interface SlashDispatchGates {
  isUserBlockedFn: typeof isUserBlocked;
  isPausedFn: typeof isPaused;
  resolveRoleFn: typeof resolveRole;
}

const productionGates: SlashDispatchGates = {
  isUserBlockedFn: isUserBlocked,
  isPausedFn: isPaused,
  resolveRoleFn: resolveRole,
};

/**
 * Route a chat-input interaction to its registry entry's bound handler;
 * ignore anything else.
 *
 * SECURITY: a slash interaction never passes through `Router.handle()`, so
 * the router's pre-turn spine cannot gate it — this dispatcher mirrors the
 * spine's leading steps itself, in the spine's order, so the gates are base's
 * and a module handler cannot forget them (audit S5):
 *
 *  - **block-list** first, silently: a blocked caller gets zero footprint —
 *    no reply, no dispatch — matching `blockListStep`'s zero-footprint rule.
 *    Fails OPEN on a read error (log and dispatch), the same posture as the
 *    router's catch: one failed check must never itself become an outage.
 *  - **role resolution** next, failing CLOSED to `guest`, and the resolved
 *    tier rides into the handler on `deps.caller` — never re-derived (or
 *    forgotten) by the handler itself.
 *  - **pause** last, exempting super admins exactly as `pauseStep` does (so
 *    they can resume), with an ephemeral notice through `deps.filtered` —
 *    ephemeral, so a pause is not broadcast to the channel, and no debounce,
 *    because an explicit slash invocation is not a busy channel's spray.
 *
 * Rate-limit and daily-budget are deliberately NOT mirrored: both exist to
 * bound model-turn cost, and a slash command never starts a model turn. If a
 * command ever grows one, it takes the whole spine, not a wider copy here.
 */
export async function handleInteraction(
  interaction: Interaction,
  deps: Omit<SlashCommandDeps, 'caller'>,
  gates: SlashDispatchGates = productionGates,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const command = registeredCommands().find((c) => c.name === interaction.commandName);
  if (!command?.discord) return;

  try {
    if (await gates.isUserBlockedFn('discord', interaction.user.id)) return;
  } catch (err) {
    logger.error({ err }, 'Slash block-list check failed; treating caller as not blocked');
  }

  let role: Tier;
  try {
    role = await gates.resolveRoleFn('discord', interaction.user.id);
  } catch (err) {
    logger.error({ err }, 'Slash role resolution failed; treating caller as guest');
    role = 'guest';
  }

  if (role !== 'super_admin' && (await gates.isPausedFn().catch(() => false))) {
    try {
      await interaction.reply({
        content: await deps.filtered(notice('pauseNotice')),
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      // A failed notice must not un-pause the gate — the dispatch stays refused.
      logger.warn({ err }, 'Slash pause notice failed to send');
    }
    return;
  }

  await command.discord.handle(interaction, {
    ...deps,
    caller: { userId: interaction.user.id, role },
  });
}
