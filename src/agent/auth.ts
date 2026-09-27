import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Configure the process environment for the model credential the config
 * chose (`AGENT_MODEL_AUTH`, agent-base G1). The SDK spawns the Claude Code
 * binary, which reads its credential from the environment.
 *
 * - oauth: the Claude *subscription* (CLAUDE_CODE_OAUTH_TOKEN, from
 *   `claude setup-token`). ANTHROPIC_API_KEY is cleared so a stray key can't
 *   silently switch billing to the metered API.
 * - gateway: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, a model gateway that
 *   holds the real credential. ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
 *   are cleared, so the CLI cannot go around the gateway.
 */
export function configureSubscriptionAuth(): void {
  if (config.llm.auth === 'gateway') {
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
      if (process.env[name]) {
        logger.warn(`${name} is set but gateway auth is configured; clearing it for this process.`);
        delete process.env[name];
      }
    }
    process.env.ANTHROPIC_BASE_URL = config.llm.gatewayBaseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = config.llm.gatewayToken;
    logger.info('Model gateway auth configured (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN).');
    return;
  }
  process.env.CLAUDE_CODE_OAUTH_TOKEN = config.llm.oauthToken;

  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn(
      'ANTHROPIC_API_KEY is set but subscription-only auth is configured; clearing it for this process.',
    );
    delete process.env.ANTHROPIC_API_KEY;
  }
  logger.info('Claude subscription auth configured (CLAUDE_CODE_OAUTH_TOKEN).');
}
