import { config } from '../config.js';

/**
 * A module-registered secret source. A GETTER rather than a value, because the
 * credentials modules hold (OAuth refresh tokens above all) rotate at runtime —
 * a value captured at registration would redact yesterday's token and let
 * today's through. Return `undefined` while the credential does not exist yet;
 * redactSecrets ignores empty/short values, so an unset optional is safe.
 */
export type RuntimeSecretGetter = () => string | undefined;

const registered: RuntimeSecretGetter[] = [];

/**
 * Register a module's outward credential with the exact-value redaction
 * backstop (PHASE-4 §8.2 / the `secrets` seam in MODULE-API.md). Additive, like
 * `registerProvenance`: base's own list stays hand-written below, and every
 * registered getter is read fresh on each `runtimeSecrets()` call — i.e. on
 * every outbound send. Modules normally reach this through the
 * `AgentModule.runtimeSecrets` manifest field rather than calling it directly.
 */
export function registerRuntimeSecret(getter: RuntimeSecretGetter): void {
  registered.push(getter);
}

/**
 * Exact secret values that must never leave the process in any outbound
 * message. Consumed by the adapters' send paths (see outbound.redactSecrets).
 * Empty/short values are ignored by redactSecrets, so unset optionals are safe.
 *
 * A THROWING getter propagates deliberately: the send it was serving fails
 * rather than going out with that credential unredacted. Failing the message is
 * recoverable; leaking a mailbox token is not (fail closed, same posture as
 * every registry read).
 */
export function runtimeSecrets(): string[] {
  return [
    config.llm.oauthToken,
    config.discord.botToken,
    config.db.url,
    config.whatsapp.cloud.accessToken ?? '',
    config.whatsapp.cloud.verifyToken ?? '',
    config.whatsapp.cloud.appSecret ?? '',
    config.devTeam.authToken ?? '',
    // The fine-grained GitHub PAT (issue filing) is the bot's only outward
    // WRITE credential — include it here so the exact-value backstop covers any
    // future/unknown egress path, not just the one send site that redacts it
    // today (audit M2).
    config.github.token ?? '',
    // The bosun fleet-supervisor bearer token (fleet/heartbeat.ts). Read
    // straight from the environment because that is where the heartbeat reads
    // it — no config slice exists for the fleet vars — and re-read per call
    // like everything else here. docs/SECURITY.md §1's rule is that every
    // base credential joins this list in the diff that introduces it; this
    // one shipped without it (audit S6).
    process.env.FLEET_SUPERVISOR_TOKEN ?? '',
    ...registered.map((getter) => getter() ?? ''),
  ];
}
