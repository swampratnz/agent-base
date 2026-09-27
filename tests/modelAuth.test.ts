import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { loadConfig } = await import('../src/config.js');
const { shellSafeEnv } = await import('../src/agent/core.js');

const BASE_ENV = {
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_GUILD_ID: '1',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
};
const OAUTH = 'sk-ant-oat01-subscription-token-value';
const GATEWAY = 'wbgw_gateway-token-value-for-this-org';
const API_KEY = 'sk-ant-api03-a-stray-api-key-value';

test('model auth: oauth is the default and still requires CLAUDE_CODE_OAUTH_TOKEN, with the same message', () => {
  const built = loadConfig({ ...BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
  assert.equal(built.llm.auth, 'oauth');
  assert.equal(built.llm.oauthToken, OAUTH);
  assert.equal(built.llm.gatewayToken, '');
  assert.throws(
    () => loadConfig({ ...BASE_ENV }),
    /CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN is required/,
  );
  assert.throws(
    () => loadConfig({ ...BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: '' }),
    /CLAUDE_CODE_OAUTH_TOKEN is required/,
  );
});

test('model auth: gateway mode needs ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, and no subscription token', () => {
  const built = loadConfig({
    ...BASE_ENV,
    AGENT_MODEL_AUTH: 'gateway',
    ANTHROPIC_BASE_URL: 'http://10.89.0.1:8900',
    ANTHROPIC_AUTH_TOKEN: GATEWAY,
  });
  assert.equal(built.llm.auth, 'gateway');
  assert.equal(built.llm.gatewayBaseUrl, 'http://10.89.0.1:8900');
  assert.equal(built.llm.gatewayToken, GATEWAY);
  assert.equal(built.llm.oauthToken, '');

  assert.throws(
    () => loadConfig({ ...BASE_ENV, AGENT_MODEL_AUTH: 'gateway', ANTHROPIC_AUTH_TOKEN: GATEWAY }),
    /AGENT_MODEL_AUTH=gateway requires ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN/,
  );
  assert.throws(
    () =>
      loadConfig({ ...BASE_ENV, AGENT_MODEL_AUTH: 'gateway', ANTHROPIC_BASE_URL: 'http://10.89.0.1:8900' }),
    /requires ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        AGENT_MODEL_AUTH: 'gateway',
        ANTHROPIC_BASE_URL: 'not a url',
        ANTHROPIC_AUTH_TOKEN: GATEWAY,
      }),
    /ANTHROPIC_BASE_URL/,
  );
});

test('SECURITY: gateway mode refuses a subscription token beside the gateway token', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        AGENT_MODEL_AUTH: 'gateway',
        ANTHROPIC_BASE_URL: 'http://10.89.0.1:8900',
        ANTHROPIC_AUTH_TOKEN: GATEWAY,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      }),
    /AGENT_MODEL_AUTH=gateway refuses CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test('model auth: an unknown AGENT_MODEL_AUTH is refused', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, AGENT_MODEL_AUTH: 'api_key' }),
    /AGENT_MODEL_AUTH/,
  );
});

test('SECURITY: the CLI child env keeps the subscription token in oauth mode and strips other secrets', () => {
  const env = {
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    DATABASE_URL: 'postgres://u:secretpw@h/db',
  };
  const out = shellSafeEnv(env, 'oauth', [OAUTH, env.DATABASE_URL]);
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
  assert.equal(out.DATABASE_URL, undefined);
  assert.equal(out.PATH, '/usr/bin');
});

test('SECURITY: the CLI child env in gateway mode carries the gateway token and URL, never a subscription token or API key', () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'http://10.89.0.1:8900',
    ANTHROPIC_AUTH_TOKEN: GATEWAY,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    ANTHROPIC_API_KEY: API_KEY,
    DATABASE_URL: 'postgres://u:secretpw@h/db',
  };
  // The gateway token is a registered runtime secret, and still survives.
  const out = shellSafeEnv(env, 'gateway', [GATEWAY, env.DATABASE_URL]);
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, GATEWAY);
  assert.equal(out.ANTHROPIC_BASE_URL, 'http://10.89.0.1:8900');
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.DATABASE_URL, undefined);
  assert.ok(!Object.values(out).includes(OAUTH) && !Object.values(out).includes(API_KEY));
});
