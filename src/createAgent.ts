/**
 * `createAgent({ modules })` — the composition entry point.
 *
 * ## Why this exists
 *
 * community-agent composes by SIDE-EFFECT IMPORT: `src/index.ts` imports a
 * dozen module-owned files in a load-bearing order, each of which calls a
 * registration function at its own module scope. That works exactly once, for
 * exactly one module, in one repo where the author can see the whole list.
 * It has three properties a framework cannot ship:
 *
 *   1. the ORDER lives in an import list, where nothing enforces it and a
 *      reordering linter or an auto-import can silently break boot;
 *   2. a FORGOTTEN import is discovered at first use — a blank notice, a
 *      narrower tool surface, a thrown accessor in front of a member — not at
 *      startup;
 *   3. registration happens as a side effect of importing, so a base module
 *      that merely LOOKED at a registry at its own module scope (the `_MI`
 *      notice constants did) made import order a correctness problem.
 *
 * This function fixes all three: the order is here and frozen, the readiness
 * gate runs BEFORE anything can serve a turn and reports every gap at once,
 * and (3) is handled by the residue pass that moved base's registry reads to
 * their call sites.
 *
 * ## The order
 *
 * 1. **plan** — a PURE pass over the manifests: unique names, exactly one
 *    claimant per once-per-process registry, and every required registry
 *    claimed by somebody. It runs before ANY side effect, so a composition
 *    that cannot serve a turn is rejected with the process untouched: no
 *    half-filled registries, no init hook that already opened a socket.
 *    Every problem found is reported together, not one boot at a time.
 * 2. **init** — every module's `init()`, in declaration order. Nothing is
 *    registered yet, so an init hook cannot observe another module's
 *    registrations and cannot race them.
 * 3. **singleton registries** — notice pack, tool tiers, tool-server parts,
 *    flagged-tool predicates, skills manifest, prompt sections, commands,
 *    default bad words.
 * 4. **additive registries** — personas, turn-state finalizers, policy keys,
 *    provenance, purge contributors, pre-turn intercepts, post-turn handlers,
 *    runtime secrets.
 *    Appended in module declaration order; base owns the ITERATION order
 *    (each of these registries sorts by its own `order`/spine rules), so
 *    declaration order never decides behaviour.
 * 5. **the readiness gate** — `assertRegistrationsComplete()` probes the real
 *    accessors. Step 1 proved the manifests SAY they fill everything; this
 *    proves the registries actually took it.
 * 6. **migrations** — base fragments first, then module fragments, as ONE
 *    query (see storage/migrate.ts).
 * 7. **start** — only now can a turn run.
 *
 * Nothing here can reorder or replace the frozen spine (`PRE_TURN_SPINE`),
 * the prompt slot order, or any enforcement point. A module appends; it does
 * not sequence.
 */
import type { NoticeAxes, NoticeEntry, NoticeValue } from './strings/catalogue.js';
import { isNoticePackRegistered, registerNoticePack } from './strings/catalogue.js';
import type { ToolTierRegistration } from './auth/rbac.js';
import { areToolTiersRegistered, registerToolTiers } from './auth/rbac.js';
import type { ToolServerParts } from './agent/toolServer.js';
import { registerToolServerParts, toolServerName } from './agent/toolServer.js';
import type { FlaggedToolPredicate } from './agent/featureFlags.js';
import { flaggedToolPredicates, registerFlaggedToolPredicates } from './agent/featureFlags.js';
import type { SkillsManifest } from './agent/skillsManifest.js';
import { registerSkillsManifest, skillsManifest } from './agent/skillsManifest.js';
import type { ModulePromptSections } from './agent/promptSpine.js';
import { promptSections, registerPromptSections } from './agent/promptSpine.js';
import type { Persona } from './agent/personaRegistry.js';
import { defaultPersonaId, registerPersona } from './agent/personaRegistry.js';
import type { TurnStateFinalizer } from './agent/turnState.js';
import { registerTurnStateFinalizer } from './agent/turnState.js';
import type { RegisteredCommand } from './commands/registry.js';
import { registerCommands, registeredCommands } from './commands/registry.js';
import { areDefaultBadWordsRegistered, registerDefaultBadWords } from './moderation/wordlist.js';
import { registerPolicyKeys } from './storage/policyStore.js';
import type { ProvenanceTrust } from './storage/provenance.js';
import { registerProvenance } from './storage/provenance.js';
import type { PurgeContributor } from './storage/lifecycle.js';
import { registerPurgeContributor } from './storage/lifecycle.js';
import type { PreTurnIntercept, PostTurnHandler } from './routerIntercepts.js';
import { registerPostTurnHandler, registerPreTurnIntercept } from './routerIntercepts.js';
import type { RuntimeSecretGetter } from './agent/secrets.js';
import { registerRuntimeSecret } from './agent/secrets.js';
import type { ModuleMigrationFragment } from './storage/migrate.js';
import { migrate } from './storage/migrate.js';
import { logger } from './logger.js';

/**
 * What a module hands `createAgent`.
 *
 * Every field is optional EXCEPT `name`, because a deployment may be composed
 * of several modules that each fill part of the surface — the completeness
 * requirement is on the composition as a whole (step 1), not on any one
 * module.
 *
 * This is THE contract, and since #10 the only one: it is typed against the
 * registries that actually exist, and the barrel exports it — as both
 * `AgentModule` and the alias `AgentModuleManifest`. It used to share the
 * `AgentModule` name with a v0 sketch under `src/module-api/`, which a module
 * author could build against by accident because both were exported and
 * neither mentioned the other at the point of import. Extension points whose
 * runtime does not exist yet are described in docs/MODULE-API.md under
 * `planned`, and export no type at all.
 *
 * `Ctx` is the module's own per-turn tool-context type — the thing its
 * `toolServerParts.makeContext` builds and its tool handlers receive. The base
 * never looks inside it, so the parameter exists purely so a module CAN pin it
 * (`AgentModule<ToolContext>` typechecks every handler against the real
 * context) and defaults to `unknown` so a module need not
 * (`AgentModule` alone still accepts a real parts object, via the deliberate
 * bivariance documented on `ToolServerToolDef`).
 *
 * It was `toolServerParts?: ToolServerParts<never>` in 0.1.0, which no module
 * could satisfy — `makeContext` RETURNS the context, and nothing but `never`
 * is assignable to `never` — so the first consumer had to cast. Nothing about
 * the registration boundary required that: `registerToolServerParts` is
 * generic and the runtime storage is `ToolServerParts<any>`; only this field's
 * type was wrong.
 */
export interface AgentModule<Ctx = unknown> {
  /** Unique module name. Used in every error message this file raises. */
  name: string;

  /** Called before ANY registration happens, in declaration order. */
  init?: () => void | Promise<void>;

  // --- singleton registries: at most one module may supply each -----------
  /** The notice pack. Must cover every id in `BASE_NOTICE_IDS`. */
  notices?: { axes: NoticeAxes; entries: Record<string, NoticeEntry<NoticeValue>> };
  /** Per-tier tool-name lists the RBAC surface is derived from. */
  toolTiers?: ToolTierRegistration;
  /** The tool inventory and its MCP server name. */
  toolServerParts?: ToolServerParts<Ctx>;
  /** Feature-flag predicates dropping tools per turn. */
  flaggedToolPredicates?: readonly FlaggedToolPredicate[];
  /** The bundled-skills allowlist. */
  skills?: SkillsManifest;
  /** The closed prompt-section slot set. */
  promptSections?: ModulePromptSections;
  /** The command roster (Discord slash + WhatsApp text). */
  commands?: readonly RegisteredCommand[];
  /** The default moderation term list. */
  defaultBadWords?: readonly string[];

  // --- additive registries -------------------------------------------------
  personas?: readonly { persona: Persona; isDefault?: boolean }[];
  turnStateFinalizers?: readonly TurnStateFinalizer[];
  /** policy key → default value. */
  policyKeys?: Readonly<Record<string, unknown>>;
  provenance?: readonly { id: string; trust: ProvenanceTrust }[];
  purgeContributors?: readonly PurgeContributor[];
  preTurnIntercepts?: readonly PreTurnIntercept[];
  postTurnHandlers?: readonly PostTurnHandler[];
  /**
   * Getters for the module's own outward credentials (OAuth tokens, API keys),
   * folded into the exact-value redaction backstop every adapter send path
   * applies. Getters, not values: a rotated token is covered on the next send
   * without re-registration.
   */
  runtimeSecrets?: readonly RuntimeSecretGetter[];
  /** Schema fragments, applied after every base fragment. */
  migrations?: readonly ModuleMigrationFragment[];
}

export interface CreateAgentOptions {
  modules: readonly AgentModule[];
  /**
   * Run migrations during `start()`. Default true. Set false where a
   * deployment migrates out-of-band (a release step, a canary job).
   */
  migrateOnStart?: boolean;
}

export interface Agent {
  /** Module names, in declaration order. */
  readonly modules: readonly string[];
  /** True once `start()` has completed — i.e. once a turn may run. */
  readonly started: boolean;
  /**
   * Bring the runtime up: migrations (base-first), then `run`. Registration
   * and the readiness gate already happened in `createAgent`, so by the time
   * anything here executes the surface is known-complete.
   */
  start(run?: () => Promise<void> | void): Promise<void>;
  /**
   * Guard for anything that would serve a turn. Throws until `start()` has
   * completed, so a caller that wires an adapter's message handler before
   * boot finishes gets a loud failure, not a half-registered turn.
   */
  assertStarted(): void;
}

/** One required registry: which manifest field claims it, how to probe it. */
interface Requirement {
  registry: string;
  /** Which `AgentModule` field supplies it. */
  field: keyof AgentModule;
  /** Is this module's value an actual claim? (A persona list with no default is not.) */
  claimed: (mod: AgentModule) => boolean;
  probe: () => boolean;
}

/** A field counts as claimed when the module supplies it at all. */
function present(field: keyof AgentModule): (mod: AgentModule) => boolean {
  return (mod) => mod[field] !== undefined;
}

/**
 * The registries base itself reads on the turn path. Each has a fail-closed
 * accessor already; the gate exists so all the gaps surface AT ONCE, at
 * startup, instead of one at a time at first use.
 *
 * Kept sorted by registry name (same anti-merge-conflict reasoning as
 * `tests/security-floor.json`).
 */
const REQUIREMENTS: readonly Requirement[] = Object.freeze([
  {
    registry: 'commands',
    field: 'commands',
    claimed: present('commands'),
    probe: probes(registeredCommands),
  },
  {
    registry: 'default bad words',
    field: 'defaultBadWords',
    claimed: present('defaultBadWords'),
    probe: areDefaultBadWordsRegistered,
  },
  {
    registry: 'default persona',
    field: 'personas',
    // A persona list with no default is not a claim: `defaultPersonaId()`
    // would still fail closed, so say so at plan time rather than at boot.
    claimed: (mod) => (mod.personas ?? []).some((entry) => entry.isDefault === true),
    probe: probes(defaultPersonaId),
  },
  {
    registry: 'flagged-tool predicates',
    field: 'flaggedToolPredicates',
    claimed: present('flaggedToolPredicates'),
    probe: probes(flaggedToolPredicates),
  },
  {
    registry: 'notice pack',
    field: 'notices',
    claimed: present('notices'),
    probe: isNoticePackRegistered,
  },
  {
    registry: 'prompt sections',
    field: 'promptSections',
    claimed: present('promptSections'),
    probe: probes(promptSections),
  },
  {
    registry: 'skills manifest',
    field: 'skills',
    claimed: present('skills'),
    probe: probes(skillsManifest),
  },
  {
    registry: 'tool tiers',
    field: 'toolTiers',
    claimed: present('toolTiers'),
    probe: areToolTiersRegistered,
  },
  {
    registry: 'tool-server parts',
    field: 'toolServerParts',
    claimed: present('toolServerParts'),
    probe: probes(toolServerName),
  },
]);

/** Turn a fail-closed accessor into a non-throwing readiness probe. */
function probes(read: () => unknown): () => boolean {
  return () => {
    try {
      read();
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The readiness gate. Throws — naming every unfilled registry and the module
 * field that fills it — if the composition is incomplete.
 *
 * Exported so a test (or a deployment's own smoke check) can assert
 * completeness independently of `createAgent`.
 */
export function assertRegistrationsComplete(): void {
  const missing = REQUIREMENTS.filter((req) => !req.probe());
  if (missing.length === 0) return;
  const lines = missing.map((req) => `  - ${req.registry} (no module supplied \`${req.field}\`)`);
  throw new Error(
    `createAgent: ${missing.length} required registration(s) missing — the agent cannot serve a turn:\n` +
      `${lines.join('\n')}\n` +
      'Every one of these has a fail-closed accessor, so leaving it unfilled would otherwise surface as a ' +
      'thrown accessor or a blank member-facing string at first use rather than at startup.',
  );
}

/** The once-per-process registries, and the manifest field that owns each. */
const SINGLETONS: readonly { registry: string; field: keyof AgentModule }[] = Object.freeze([
  { registry: 'notice pack', field: 'notices' },
  { registry: 'tool tiers', field: 'toolTiers' },
  { registry: 'tool-server parts', field: 'toolServerParts' },
  { registry: 'flagged-tool predicates', field: 'flaggedToolPredicates' },
  { registry: 'skills manifest', field: 'skills' },
  { registry: 'prompt sections', field: 'promptSections' },
  { registry: 'commands', field: 'commands' },
  { registry: 'default bad words', field: 'defaultBadWords' },
]);

/**
 * The PURE plan pass (step 1). Reports every structural problem in the
 * composition together, before a single init hook or registration runs — so a
 * rejected composition leaves the process exactly as it found it.
 *
 * Exported so a deployment can validate its manifest set in a test or a CI
 * check without the side effects of actually composing.
 */
export function planComposition(modules: readonly AgentModule[]): void {
  if (modules.length === 0) {
    throw new Error('createAgent: no modules supplied — the base ships no content and cannot serve a turn.');
  }
  const problems: string[] = [];
  const names = modules.map((m) => m.name);
  for (const [i, name] of names.entries()) {
    if (names.indexOf(name) !== i) problems.push(`duplicate module name '${name}' — names must be unique`);
  }
  for (const { registry, field } of SINGLETONS) {
    const claimants = modules.filter((mod) => mod[field] !== undefined).map((mod) => `'${mod.name}'`);
    if (claimants.length > 1) {
      problems.push(
        `modules ${claimants.join(' and ')} both supply the ${registry}, which is a ` +
          'once-per-process registration — exactly one module may own it',
      );
    }
  }
  for (const req of REQUIREMENTS) {
    if (!modules.some((mod) => req.claimed(mod))) {
      problems.push(`${req.registry} (no module supplied \`${req.field}\`)`);
    }
  }
  if (problems.length === 0) return;
  throw new Error(
    `createAgent: ${problems.length} problem(s) with this composition — the agent cannot serve a turn:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\nEvery required registry has a fail-closed accessor, so leaving one unfilled would otherwise ' +
      'surface as a thrown accessor or a blank member-facing string at first use rather than at startup.',
  );
}

/**
 * Compose an agent from module manifests. Performs every registration, then
 * refuses to hand back an `Agent` at all unless the surface is complete.
 */
export async function createAgent(options: CreateAgentOptions): Promise<Agent> {
  const modules = options.modules;
  const names = modules.map((m) => m.name);

  // 1. plan — pure, and the only step that can reject with the process
  //    untouched. Everything below has side effects.
  planComposition(modules);

  // 2. init, before anything is registered.
  for (const mod of modules) await mod.init?.();

  // 3. singleton registries. planComposition already proved there is at most
  //    one claimant for each, so these cannot collide.
  for (const mod of modules) {
    if (mod.notices) registerNoticePack(mod.notices.axes, mod.notices.entries);
    if (mod.toolTiers) registerToolTiers(mod.toolTiers);
    if (mod.toolServerParts) registerToolServerParts(mod.toolServerParts);
    if (mod.flaggedToolPredicates) registerFlaggedToolPredicates(mod.flaggedToolPredicates);
    if (mod.skills) registerSkillsManifest(mod.skills);
    if (mod.promptSections) registerPromptSections(mod.promptSections);
    if (mod.commands) registerCommands(mod.commands);
    if (mod.defaultBadWords) registerDefaultBadWords(mod.defaultBadWords);
  }

  // 4. additive registries. Base owns ITERATION order inside each of these
  //    (purge contributors sort by `order`, intercepts append after the frozen
  //    spine, prompt slots are fixed), so declaration order never decides
  //    behaviour — it only decides which module is asked first.
  for (const mod of modules) {
    for (const entry of mod.personas ?? []) registerPersona(entry.persona, { isDefault: entry.isDefault });
    for (const finalizer of mod.turnStateFinalizers ?? []) registerTurnStateFinalizer(finalizer);
    if (mod.policyKeys) registerPolicyKeys({ ...mod.policyKeys });
    for (const entry of mod.provenance ?? []) registerProvenance(entry);
    for (const contributor of mod.purgeContributors ?? []) registerPurgeContributor(contributor);
    for (const intercept of mod.preTurnIntercepts ?? []) registerPreTurnIntercept(intercept);
    for (const handler of mod.postTurnHandlers ?? []) registerPostTurnHandler(handler);
    for (const getter of mod.runtimeSecrets ?? []) registerRuntimeSecret(getter);
  }

  // 5. the probe gate — the manifests SAID they fill everything; this checks
  //    the registries actually took it, before a turn can possibly run.
  assertRegistrationsComplete();

  // 6/7. migrations then start, deferred to start() so a caller can decide
  //      when the process actually goes live.
  const fragments = modules.flatMap((mod) => mod.migrations ?? []);
  let started = false;

  const agent: Agent = {
    modules: Object.freeze([...names]),
    get started() {
      return started;
    },
    async start(run?: () => Promise<void> | void) {
      if (started) throw new Error('createAgent: agent already started');
      if (options.migrateOnStart !== false) await migrate(fragments);
      await run?.();
      started = true;
      logger.info({ modules: names }, 'Agent started');
    },
    assertStarted() {
      if (!started) {
        throw new Error(
          'createAgent: the agent has not started — nothing may serve a turn before start() completes.',
        );
      }
    },
  };
  return agent;
}
