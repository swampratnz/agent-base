import type { Client, Interaction } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { registeredCommands, type SlashCommandDeps } from '../../commands/registry.js';

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

/** Route a chat-input interaction to its registry entry's bound handler; ignore anything else. */
export async function handleInteraction(interaction: Interaction, deps: SlashCommandDeps): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const command = registeredCommands().find((c) => c.name === interaction.commandName);
  if (!command?.discord) return;
  await command.discord.handle(interaction, deps);
}
