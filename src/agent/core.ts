import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  query,
  type HookJSONOutput,
  type McpServerConfig,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notice, type NoticeSelection } from '../strings/catalogue.js';
import { atLeast, toolsForRole, type CallerContext } from '../auth/rbac.js';
import { superAdminIds } from '../auth/roles.js';
import type { AdapterLookup, IncomingMessage, Platform, PlatformAdapter } from '../platforms/types.js';
import { KNOWN_PLATFORMS } from '../platforms/registry.js';
import {
  clearClaudeSessionId,
  getClaudeSession,
  getLanguagePreference,
  getResponseStyle,
  recentConversationTail,
  searchMemory,
  setClaudeSessionId,
  type StoredSession,
  type ConversationTailRow,
  type LanguagePreference,
  type ResponseStyle,
} from '../storage/repository.js';
import { ALL_BUILTIN_TOOLS, isMutatingArmed, MUTATING_BUILTIN_TOOLS } from './builtinTools.js';
import { runtimeSecrets } from './secrets.js';
import { finalizeTurnState, type BuiltinWebSearchUse, type TurnStateBag } from './turnState.js';
import { getCodeAnswersPolicy } from '../storage/policyStore.js';
import { queuePendingAlert } from '../pendingAlertQueue.js';
import {
  buildSystemPrompt,
  type PromptPolicy,
  renderConversationTail,
  renderMemoryContext,
  renderRequesterTag,
} from './systemPrompt.js';
import { selectPersona } from './personaRegistry.js';
import { buildToolServer, registeredToolIds, toolServerName } from './toolServer.js';
import type { ToolServerTurnState } from './turnState.js';
import { flaggedToolPredicates } from './featureFlags.js';
import {
  isDuplicateWebSearchQuery,
  recordWebSearchQuery,
  reserveWebSearchSlot,
  withWebSearchDedupLock,
} from './webSearchGuard.js';
import { skillsManifest } from './skillsManifest.js';
import { initialUsageLimitTracker, isUsageLimitFailure, stepUsageLimitTracker } from './upstreamFailure.js';

export interface AgentReply {
  text: string;
  costUsd?: number;
  /**
   * Cache-hit/-write token counts read from the SDK `result` message's
   * `usage` field (issue #508 added the read; issue #522 threads it here so
   * `usage_stats` can surface it instead of it only ever reaching a debug
   * log). Mirrors `costUsd` exactly: set on both the success return and the
   * non-success/max-turns return (a max-turns turn still spends real,
   * cacheable input tokens), left `undefined` on the thrown-error catch path
   * (which has no `usage`) and whenever the SDK reports no `usage` at all.
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Per-model cost split read from the SDK `result` message's `modelUsage`
   * field (issue #792) — a flat `{ [canonicalModel]: costUsd }` map, copying
   * only `costUSD` per entry (no token counts, no `provider`/`contextWindow`).
   * Mirrors `cacheReadTokens`/`cacheCreationTokens` exactly: set whenever the
   * SDK reports a non-empty `modelUsage`, left `undefined` when it is absent
   * or empty so `usage_stats` can tell "no data" from "landed on one model
   * costing nothing" (the same "absent, not zero" discipline #522 established
   * for cache telemetry).
   */
  modelUsage?: Record<string, number>;
  sessionId?: string;
  /**
   * Whether this reply is a genuine answer (`TurnOutcome.ok`), as opposed to
   * a fallback/error string (internal error, upstream usage-limit, max-turns,
   * ...). Optional so existing test doubles that construct an `AgentReply`
   * literal without it keep compiling; a caller that cares (e.g. the
   * repeat-question shortcut, issue #259) must check `=== true`, never treat
   * a missing value as truthy.
   */
  ok?: boolean;
  /**
   * Set to `true` only when the turn ended with SDK `resultSubtype ===
   * 'error_max_turns'` — a deterministic, content-independent failure (issue
   * #306's max-turns repeat shortcut). Every other branch (success, other
   * non-success subtypes, thrown-error catch) leaves this `undefined`; a
   * caller that cares must check `=== true`, never treat a missing value as
   * truthy.
   */
  maxTurnsExceeded?: boolean;
  /**
   * Set to `true` only when the module's `signal` (see {@link runAgentTurn})
   * fired and ended the turn. Such a reply is `ok: false` with an EMPTY
   * `text` and no fallback notice: the person asked for the turn to stop, so
   * the module says what it wants to say. `costUsd` and the other telemetry
   * carry whatever the CLI reported before it stopped, which is what was
   * spent. A caller that cares must check `=== true`.
   */
  stopped?: boolean;
  /**
   * The caller's standing language preference for this turn (issue #339),
   * threaded straight from the same `getLanguagePreference` lookup
   * `buildSystemPrompt` already uses — no new DB call. Left `undefined` only
   * when that lookup itself throws (see the try/catch below); a resolved
   * the caller's raw stored value is always returned as-is, never coerced. Consumed
   * downstream by the router's main-reply send to pick the `_MI` outbound
   * code-policy note.
   */
  languagePreference?: LanguagePreference;
  /**
   * The caller's standing response-style preference for this turn (issue
   * #657), threaded straight from the same `getResponseStyle` lookup used to
   * build the system prompt above — no new DB call. Unlike
   * `languagePreference`, this is never left `undefined` on a lookup
   * failure: `responseStyle` itself already degrades to `'standard'` in that
   * case (see the try/catch above), so there's no "lookup failed" state to
   * preserve. Consumed downstream by the router's main-reply send to pick
   * the `_PLAIN` outbound code-policy note — `filterOutbound`/
   * `applyCodePolicy` already prioritise a registered `languagePreference` over
   * this internally, so passing both is safe.
   */
  responseStyle?: ResponseStyle;
  /**
   * Module signals surfaced by this turn's tools — the generic turn-state
   * bag (agent-base plan §3) that replaced the five hardcoded community
   * fields (`knowledgeEntryId`, `unhelpfulAnswerRated`, `humanHelpRequested`,
   * `knowledgeGapCluster`, `staleKnowledgeAlertIds`). Threaded from
   * `TurnOutcome.turnState`; set ONLY when the turn ended in genuine success
   * (`TurnOutcome.ok === true`) AND a registered finalizer produced at least
   * one key — never a stale value from an earlier failed attempt, exactly
   * the contract every replaced field had. The KEYS are typed (and their
   * per-key contracts documented) by module augmentation in ONE
   * community-owned file, `agent/communityTurnState.ts`; consumed by the
   * router's registered post-turn handlers, never read by (or acted on
   * inside) any model-callable tool.
   */
  turnState?: Partial<TurnStateBag>;
}

/**
 * The notice ids a failed turn can fall back to. A `TurnOutcome` carries the
 * ID, not the rendered text, so the caller's preferences are applied ONCE at
 * the end of `runAgentTurn` (see `text` below).
 *
 * This replaces the two text-keyed `FALLBACK_REPLY_MI`/`_PLAIN` lookup tables
 * the community build carried. Those hardcoded the two NZ axis values into
 * base, and they matched on the rendered English string — so a pack whose
 * default text collided with a model answer could rewrite it. Threading the
 * id is both generic and the stricter discipline.
 */
export type FallbackNoticeId =
  | 'internalErrorReply'
  | 'maxTurnsReply'
  | 'turnFailedReply'
  | 'usageLimitReply'
  | 'usageLimitReplyAdminNotified';

/**
 * User-facing fallback when a turn dies on an internal failure. Shared with
 * the router's pre-send backstop (issue #52) so a DB blip mid-turn produces
 * the same degraded reply as an agent-query failure — never silence.
 *
 * A FUNCTION, not a module-scope const: a base module must be importable
 * before a module has registered its notice pack (`createAgent` registers,
 * then starts), so nothing here may render text at import time.
 */
export function internalErrorReply(selection?: NoticeSelection): string {
  return notice('internalErrorReply', selection);
}

/**
 * User-facing fallback when a turn exhausts `AGENT_MAX_TURNS` without
 * finishing. Exported so the router's max-turns repeat shortcut (issue #306)
 * can replay the exact same, fixed, content-independent string on a cached
 * hit instead of duplicating it.
 */
export function maxTurnsReply(selection?: NoticeSelection): string {
  return notice('maxTurnsReply', selection);
}

/** User-facing fallback for any other non-success `resultSubtype`. */
export function turnFailedReply(selection?: NoticeSelection): string {
  return notice('turnFailedReply', selection);
}

interface TurnOutcome {
  ok: boolean;
  resumeFailed: boolean;
  /**
   * The rendered DEFAULT text. On a failure this is the fallback notice's
   * base variant; `fallbackNoticeId` names which one, so the final
   * per-caller variant is selected once, below.
   */
  text: string;
  fallbackNoticeId?: FallbackNoticeId;
  costUsd?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  modelUsage?: Record<string, number>;
  sessionId?: string;
  maxTurnsExceeded?: boolean;
  stopped?: boolean;
  turnState?: Partial<TurnStateBag>;
}

/**
 * Drop feature-flagged tools whose config flag is off — each handler already
 * refuses independently when its flag is off (defense in depth, kept as-is),
 * but leaving them in `allowedTools` still pays their full
 * name+description+schema tokens on every turn for a tier that can never
 * successfully call them (issue #535). Purely subtractive: a tool is dropped
 * only while its flag is off. The flagged set and each tool's predicate are
 * derived from the registry (`ToolDef.featureFlag`, tools/index.ts) and
 * registered into the base predicate slot (`agent/featureFlags.ts`) at the
 * registry's import time, and every predicate is evaluated against the live
 * `config` HERE, at call time — never frozen at import, the trap the old
 * hand-maintained flag groups' import-time booleans had.
 */
export function filterFeatureFlaggedTools(tools: string[]): string[] {
  const disabled = new Set(
    flaggedToolPredicates()
      .filter((p) => !p.enabled(config))
      .map((p) => p.name),
  );
  return tools.filter((t) => !disabled.has(t));
}

/**
 * Build the SDK query options for one turn. Extracted (and exported) so the
 * security invariants are regression-testable:
 *  - built-in Claude Code tools are disabled via `tools` (empty for members;
 *    admin+ additionally get WebSearch — and ONLY WebSearch);
 *  - WebFetch is disallowed for every tier (URL construction is an
 *    exfiltration channel; fetched pages are a rich injection vector);
 *  - `allowedTools` is derived from the caller's role, further filtered by
 *    platform (Discord-only tools dropped on WhatsApp) and by feature flags
 *    (tools behind a disabled `config.*.enabled` dropped entirely, issue
 *    #535) — never from message content, and only ever a subtractive filter;
 *  - Agent Skills (issue #741, `config.agentSkills.enabled`, off by default):
 *    when off, the returned options object carries no `plugins`/`skills`
 *    keys and `tools` is byte-identical to today, for every role — the
 *    #635 prompt-review checklist stays inline in `GUIDELINES`
 *    (systemPrompt.ts) instead. When on, `'Skill'` is added to the base
 *    `tools` array (uniformly for every role, same as the checklist it
 *    replaces applied to every role) and `plugins`/`skills` load exactly
 *    the repo-bundled, code-reviewed `SKILLS_DIR` — `skills` is always the
 *    literal `ENABLED_SKILLS` array, never `'all'` and never derived from
 *    any request- or member-supplied value;
 *  - `maxTurns` is tiered by role: member/guest get the lower
 *    `AGENT_MAX_TURNS_MEMBER` ceiling, admin+ keep `AGENT_MAX_TURNS`.
 *  - `model` is tiered by role the same way (issue #382): member/guest get
 *    `AGENT_MODEL_MEMBER` when set, admin+ always keep `AGENT_MODEL`. This
 *    tiering is cosmetic to cost, not security — it must never affect the
 *    tool-gating fields above.
 *  - admin+'s WebSearch is additionally capped per-conversation via a
 *    `PreToolUse` hook (issue #412): WebSearch is the one metered, real-cost
 *    built-in tool the bot grants, and unlike the bot's own MCP tools
 *    (`create_poll`/`create_thread`/`warn_user`/`announce`, each already
 *    behind a `reserve*Slot` rolling-hour cap) it was previously bounded only
 *    by the shared `maxTurns` loop-depth ceiling. `hooks.PreToolUse` is used
 *    rather than `canUseTool` because a tool listed bare in `allowedTools`
 *    (which `WebSearch` is) auto-approves and never reaches `canUseTool` —
 *    only a `PreToolUse` hook is guaranteed to fire regardless of that
 *    auto-approval path. Member/guest turns never get this hook at all —
 *    there is nothing to gate, since `tools`/`allowedTools` already exclude
 *    WebSearch for those tiers.
 *  - the same hook additionally denies an exact-normalized repeat of a
 *    recent query in the same conversation (issue #589,
 *    `isDuplicateWebSearchQuery`/`recordWebSearchQuery` in `webSearchGuard.ts`) — the
 *    volume cap above bounds call count but never inspected the query, so an
 *    agentic turn could reformulate and re-fire the same search for no new
 *    information. The dedup CHECK runs BEFORE the volume-cap check and, on a
 *    match, denies without consuming a volume slot (a call the guard itself
 *    blocked never reaches the real search, so it shouldn't count against
 *    the hourly budget). The query is only RECORDED into the dedup history
 *    once BOTH checks pass and the call is actually going to proceed —
 *    recording it any earlier would let a query later denied by the volume
 *    cap poison the dedup history, so a retry of that exact (never-searched)
 *    query would be wrongly denied as "already searched" instead of hitting
 *    the accurate rate-limit message. Both checks share the same try/catch,
 *    so a thrown error from either fails closed identically.
 *  - the dedup check also catches near-paraphrases, not just verbatim
 *    repeats (issue #706, the growth path #589 itself named): once the
 *    exact-match check misses, `isDuplicateWebSearchQuery` embeds the query
 *    via the local, offline `embed()` (no paid-API cost) and denies if its
 *    cosine similarity against any windowed history entry meets
 *    `AGENT_WEB_SEARCH_DEDUP_SIMILARITY_THRESHOLD`. The embedding is
 *    computed at most once per call — the same vector returned by the check
 *    is passed into `recordWebSearchQuery` rather than re-embedded. A
 *    thrown/rejected `embed()` propagates into this hook's existing
 *    try/catch below and fails closed, same as the other two checks.
 *  - `await embed()` is a genuine yield point that JS run-to-completion
 *    semantics never had to contend with pre-#706, so the entire
 *    check -> volume-reserve -> record sequence is wrapped in
 *    `withWebSearchDedupLock` (`tools.ts`), serialized per conversation —
 *    without it, two WebSearch calls in the same turn could both read the
 *    dedup history before either recorded and race past the guard entirely
 *    (adversarial review on issue #706).
 */
/**
 * The child process the SDK spawns inherits this process's environment, which
 * is where every outward credential lives. For a turn that is granted `Bash`,
 * that environment is readable by the model, so strip the registered secret
 * VALUES out of the copy handed to the child.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` deliberately survives: the spawned Claude Code
 * binary authenticates with it (agent/auth.ts), so removing it would break the
 * turn outright.
 *
 * This is defence-in-depth, NOT containment, and review was right to say the
 * first version of the docs invited over-reading it: the child runs as the
 * same uid, so an armed shell can read the parent's `/proc/<pid>/environ`
 * (no `ProcSubset`/`hidepid` on this unit) or simply `cat` the `.env` — both
 * return every value filtered out here. Values shorter than 8 chars are kept
 * by design. It raises the cost of an accidental echo; it stops nothing
 * deliberate.
 */
function shellSafeEnv(): Record<string, string | undefined> {
  const secrets = new Set(runtimeSecrets().filter((value) => value.length >= 8));
  const keep = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && secrets.has(value)) continue;
    out[name] = value;
  }
  if (keep !== undefined) out.CLAUDE_CODE_OAUTH_TOKEN = keep;
  return out;
}

/**
 * Default working directory for an armed turn's file tools.
 *
 * This is a STARTING directory, not a jail: a bare tool name in
 * `allowedTools` carries no path predicate, so do not read this as
 * confinement (an earlier version of docs/SECURITY.md did, wrongly — on this
 * deployment HOME is `/opt/community-agent/home`, so this directory sits
 * INSIDE the app directory, two levels from its `.env`). `Bash` is not bound
 * by it at all; a shell can `cd` anywhere the service account may read.
 *
 * Memoised, and only ever called for an armed turn: it used to run `mkdirSync`
 * on every super-admin turn, including from the unit tests, which created the
 * directory in the developer's home directory as a side effect of a pure
 * options builder. A failure returns the intended path WITHOUT widening to
 * HOME — a file tool then simply fails, which is the fail-closed direction.
 */
let shellCwdMemo: string | null = null;
function shellCwd(): string {
  if (shellCwdMemo !== null) return shellCwdMemo;
  const dir = join(process.env.HOME ?? process.cwd(), 'agent-shell');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.warn({ err, dir }, 'Could not create the agent shell working directory');
  }
  shellCwdMemo = dir;
  return dir;
}

/**
 * `PreToolUse` gate for the mutating built-ins. Denies unless the ACTOR has a
 * live arming in THIS conversation (`builtinTools.ts`), so a prompt injection
 * riding in a group conversation cannot reach a shell: it can ask to be armed,
 * but arming only happens in the router, from a fresh message by the actor.
 *
 * A hook, not `allowedTools` omission, for the reason the WebSearch cap is a
 * hook too: a tool pre-approved in `allowedTools` never reaches `canUseTool`,
 * while a `PreToolUse` hook is guaranteed to fire either way. Fails closed on
 * a missing actor id or a thrown check.
 */
function mutatingBuiltinGate(platform: Platform, conversationId: string, actorUserId: string) {
  return {
    matcher: MUTATING_BUILTIN_TOOLS.join('|'),
    hooks: [
      async (input: unknown): Promise<HookJSONOutput> => {
        const toolName = (input as { tool_name?: unknown } | undefined)?.tool_name;
        const named = typeof toolName === 'string' ? toolName : 'That tool';
        try {
          if (actorUserId && isMutatingArmed(platform, conversationId, actorUserId)) {
            logger.warn({ platform, conversationId, tool: named }, 'Armed mutating built-in tool call');
            return { continue: true };
          }
          // The interesting security event: something in this turn tried to
          // reach a host-mutating tool it was never armed for. Logged at warn
          // so an injection attempt leaves a trace, which the first version
          // of this gate did not.
          logger.warn(
            { platform, conversationId, tool: named },
            'Denied an unarmed mutating built-in tool call',
          );
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                `${named} is not armed. A super admin must send "arm shell" in this conversation first; ` +
                'asking for it in a message can never arm it.',
            },
          };
        } catch (err) {
          logger.error({ err, conversationId }, 'Arming check threw — denying the mutating tool call');
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `${named} is unavailable — the arming check failed.`,
            },
          };
        }
      },
    ],
  };
}

export function buildQueryOptions(
  role: CallerContext['role'],
  systemPrompt: string,
  mcpServers: Record<string, McpServerConfig>,
  resumeSession: string | null,
  conversationId: string,
  platform: Platform = 'discord',
  actorUserId: string = '',
  onWebSearch?: (use: BuiltinWebSearchUse) => void,
) {
  // Web search is a privileged capability: admin+ by default, raisable to
  // super_admin only, or withheld from every tier with
  // AGENT_WEB_SEARCH_TIER=none (WattoBot #100). Every branch below that
  // grants, pre-approves, disallows or hooks WebSearch keys off this one
  // boolean, so 'none' removes the built-in and its hooks together.
  const webSearch = config.llm.webSearchTier !== 'none' && atLeast(role, config.llm.webSearchTier);
  // The full Agent SDK built-in surface is super-admin only, by the owner's
  // explicit decision (community-agent#1405 follow-up), and only inside an
  // ARMED window. Every other tier — and an UNARMED super admin — keeps the
  // pre-existing surface byte-for-byte: no built-ins for member/guest,
  // WebSearch only for admin+, and Task/WebFetch disallowed.
  //
  // Gating the grant, not just the mutating half, is the correction from
  // review: with only `Bash`/`Write`/`Edit`/`NotebookEdit` behind the hook,
  // `Read` + `WebFetch` stayed granted and auto-approved in EVERY super-admin
  // turn — a read-anything-then-send-anywhere pair reachable by injected text
  // in a group, needing no arming at all. `WebFetch` egress never passes
  // through the outbound secret redaction either.
  //
  // Empty `actorUserId` (the synthetic test call sites) fails closed.
  const fullBuiltins =
    role === 'super_admin' && actorUserId !== '' && isMutatingArmed(platform, conversationId, actorUserId);
  return {
    // Member/guest turns get the tiered AGENT_MODEL_MEMBER override when set
    // (issue #382), the same highest-volume/lowest-trust role split #347
    // already applies to maxTurns. Unset (the default) falls back to
    // config.llm.model for every role — byte-identical to pre-#382 behaviour.
    model: atLeast(role, 'admin') ? config.llm.model : (config.llm.memberModel ?? config.llm.model),
    // Optional SDK-native fallback (issue #738): applies uniformly regardless
    // of caller role/tier, since an overload condition on the shared usage
    // pool isn't role-specific. Unset (the default): no fallbackModel key at
    // all, byte-identical to pre-#738 behaviour.
    ...(config.llm.fallbackModel ? { fallbackModel: config.llm.fallbackModel } : {}),
    systemPrompt,
    mcpServers,
    // The base built-in tool set. Empty = no built-ins at all; admin+ get
    // WebSearch, and every role gets 'Skill' too when AGENT_SKILLS_ENABLED
    // (issue #741) — uniformly, no tier gating, matching the ungated
    // prompt-review checklist this replaces. `allowedTools` alone only
    // auto-approves; this list is what actually restricts the surface.
    tools: [
      ...(fullBuiltins ? ALL_BUILTIN_TOOLS : webSearch ? ['WebSearch'] : []),
      ...(config.agentSkills.enabled ? ['Skill'] : []),
    ],
    // Deliberately NOT adding 'Skill' here, unlike WebSearch above: the
    // installed SDK's own type declarations (sdk.d.ts, pinned at
    // @anthropic-ai/claude-agent-sdk@0.3.220) document that passing 'Skill'
    // into allowedTools is deprecated and that the `skills` option below
    // ("you do not need to add 'Skill' to allowedTools yourself when using
    // this option") is the intended, self-sufficient pre-approval path —
    // confirmed by tests/agentSkillsEnabled.test.ts, which pins that exact
    // wording still present in the vendored .d.ts so an SDK upgrade that
    // silently drops the guarantee fails CI instead of shipping a Skill
    // tool that's granted in `tools` but never actually approved to fire.
    allowedTools: [
      ...filterFeatureFlaggedTools(toolsForRole(role, platform)),
      ...(fullBuiltins ? ALL_BUILTIN_TOOLS : webSearch ? ['WebSearch'] : []),
    ],
    // Nothing is disallowed inside an armed super-admin window (the surface it
    // was armed for IS the full set); every other turn, including an unarmed
    // super admin's, keeps the all-tier Task/WebFetch ban.
    disallowedTools: fullBuiltins ? [] : ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
    permissionMode: 'default' as const,
    // Member/guest turns get a tighter loop-depth ceiling than admin+
    // (issue #347): MEMBER_TOOLS is a much narrower surface, so a
    // stuck/injected turn on the highest-volume, lowest-trust tier is
    // bounded to less worst-case cost. admin/super_admin are unchanged.
    maxTurns: atLeast(role, 'admin') ? config.llm.maxTurns : config.llm.memberMaxTurns,
    ...(resumeSession ? { resume: resumeSession } : {}),
    // Don't load the host machine's ~/.claude config into the agent.
    settingSources: [] as [],
    // Only inside an armed window: point the file tools at a working directory
    // and strip the registered secret VALUES from the child's environment.
    // Neither is containment — see the `shellCwd`/`shellSafeEnv` notes.
    ...(fullBuiltins ? { cwd: shellCwd(), env: shellSafeEnv() } : {}),
    // Agent Skills (issue #741): loads exactly the registered skills
    // manifest — the repo-bundled plugin directory and the literal
    // hand-written allowlist (enabledSkills.ts), with the never-'all'
    // invariant enforced at registration by skillsManifest.ts — never a
    // runtime-derived path or allowlist. Unset/disabled, this object carries
    // neither key at all (not empty-valued), so the returned options are
    // byte-identical to pre-#741 behaviour.
    ...(config.agentSkills.enabled
      ? {
          plugins: [{ type: 'local' as const, path: skillsManifest().skillsDir }],
          skills: [...skillsManifest().enabledSkills],
        }
      : {}),
    ...(webSearch || fullBuiltins
      ? {
          hooks: {
            PreToolUse: [
              ...(fullBuiltins ? [mutatingBuiltinGate(platform, conversationId, actorUserId)] : []),
              {
                matcher: 'WebSearch',
                hooks: [
                  async (input: unknown): Promise<HookJSONOutput> => {
                    // Fail closed: a thrown/rejected error while checking
                    // either the dedup or the rate cap must never let the
                    // call through unbounded — denies instead of relying on
                    // any SDK default behaviour on a hook exception, which
                    // this repo has never exercised before (issue #412
                    // AC-5, extended to the dedup check by issue #589).
                    try {
                      const toolInput = (input as { tool_input?: unknown } | undefined)?.tool_input;
                      const query =
                        toolInput &&
                        typeof toolInput === 'object' &&
                        typeof (toolInput as { query?: unknown }).query === 'string'
                          ? (toolInput as { query: string }).query
                          : '';

                      const dedupWindowMs = config.llm.webSearchDedupWindowSeconds * 1000;
                      // The whole check -> volume-reserve -> record sequence is serialized per
                      // conversation (issue #706 adversarial review): `await embed()` inside
                      // `isDuplicateWebSearchQuery` is a genuine yield point, so without this lock
                      // two WebSearch calls issued in the same turn could both pass the dedup
                      // check before either records, racing past both the exact-match and
                      // similarity guards. `withWebSearchDedupLock` restores the atomicity this
                      // hook had before that `await` existed.
                      return await withWebSearchDedupLock(conversationId, async () => {
                        const { duplicate, embedding } = await isDuplicateWebSearchQuery(
                          conversationId,
                          query,
                          dedupWindowMs,
                          config.llm.webSearchDedupSimilarityThreshold,
                        );
                        if (duplicate) {
                          return {
                            continue: true,
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'deny',
                              permissionDecisionReason:
                                'You already searched for this in the last few minutes — use what you found.',
                            },
                          };
                        }

                        const allowed = reserveWebSearchSlot(
                          conversationId,
                          config.llm.webSearchRateLimitPerHour,
                        );
                        if (!allowed) {
                          return {
                            continue: true,
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'deny',
                              permissionDecisionReason:
                                'WebSearch already hit the conversation limit ' +
                                `(${config.llm.webSearchRateLimitPerHour}/hour) — try again later.`,
                            },
                          };
                        }

                        // Only record once the call is actually going to proceed — recording a
                        // query that then gets denied by the volume cap would poison the dedup
                        // history with a search that never ran (issue #589 review). `embedding` is
                        // the SAME vector isDuplicateWebSearchQuery already computed above — reused
                        // rather than re-embedded (issue #706).
                        recordWebSearchQuery(
                          conversationId,
                          query,
                          dedupWindowMs,
                          config.llm.webSearchDedupHistorySize,
                          embedding,
                        );
                        return { continue: true };
                      });
                    } catch (err) {
                      logger.error(
                        { err, conversationId },
                        'WebSearch rate-limit/dedup check threw — failing closed (denying the call)',
                      );
                      return {
                        continue: true,
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason:
                            'WebSearch is temporarily unavailable — an internal error occurred while ' +
                            'checking the rate limit.',
                        },
                      };
                    }
                  },
                ],
              },
            ],
            // Report each built-in WebSearch that actually ran to the caller
            // (WattoBot #100): the query and the result URLs, read from the
            // SDK's own PostToolUse payload. `execTurn` collects them onto
            // `turnState.builtinWebSearches` so a module can fence, footer
            // and attribute results that never crossed its tool wrapper.
            // Absent when no sink is supplied (the synthetic test call sites).
            ...(webSearch && onWebSearch
              ? {
                  PostToolUse: [
                    {
                      matcher: 'WebSearch',
                      hooks: [
                        async (input: unknown): Promise<HookJSONOutput> => {
                          onWebSearch(builtinWebSearchUse(input));
                          return { continue: true };
                        },
                      ],
                    },
                  ],
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Pull the query and result URLs out of a WebSearch PostToolUse payload. The
 * shape is the SDK's `WebSearchOutput` (sdk-tools.d.ts): `results` mixes hit
 * groups (`{ content: [{ title, url }] }`) with plain commentary strings, so
 * everything is read defensively and an unexpected shape yields an empty
 * URL list rather than a thrown hook.
 */
export function builtinWebSearchUse(input: unknown): BuiltinWebSearchUse {
  const hook = input as
    { tool_input?: { query?: unknown }; tool_response?: { results?: unknown } } | null | undefined;
  const query = typeof hook?.tool_input?.query === 'string' ? hook.tool_input.query : '';
  const urls: string[] = [];
  const results = Array.isArray(hook?.tool_response?.results) ? hook.tool_response.results : [];
  for (const group of results) {
    const content = (group as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const hit of content) {
      const url = (hit as { url?: unknown } | null)?.url;
      if (typeof url === 'string') urls.push(url);
    }
  }
  return { query, urls };
}

/**
 * Bounds a copy of the member's message before it reaches the paid model call
 * (MAX_INCOMING_MESSAGE_CHARS; `maxChars <= 0` disables — byte-identical to
 * unbounded). Below the cap, `text` is returned unchanged (no marker). Above
 * it, the cut point steps back off a split UTF-16 surrogate pair (rather than
 * slicing through one) so the result is always well-formed UTF-16, and a
 * fixed, non-model-composed marker stating the exact omitted-character count
 * is appended — mirroring `truncateForEcho`'s slice-plus-suffix shape.
 */
export function truncateIncomingMessage(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  let cut = maxChars;
  const before = text.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) {
    // A high surrogate at the boundary means its low surrogate is at `cut` —
    // step back one so the pair is never split.
    cut -= 1;
  }
  const omitted = text.length - cut;
  return `${text.slice(0, cut)}\n\n[message truncated: ${omitted} characters omitted]`;
}

/** sha256 of an assembled system prompt, stored with the session it started. */
export function systemPromptFingerprint(systemPrompt: string): string {
  return createHash('sha256').update(systemPrompt).digest('hex');
}

/**
 * Assemble a turn's prompt policy, including whether the mutating built-ins
 * are armed for THIS actor in THIS conversation.
 *
 * Exported purely as a test seam, and that is the point. The 0.7.0 arming bug
 * was not a type error — every argument was threaded correctly — it was that
 * nothing asserted the production path ever consulted `isMutatingArmed`. A
 * flag with a safe default and no behaviour test is how a feature ships
 * switched off while every gate reports success. The arming key is
 * (platform, conversationId, userId), matching what the router's arm-shell
 * step wrote and what `buildQueryOptions` checks, so all three agree by
 * construction.
 */
export function promptPolicyFor(
  caller: CallerContext,
  codeAnswers: PromptPolicy['codeAnswers'],
  responseStyle: string,
  languagePreference: string,
): PromptPolicy {
  return {
    codeAnswers,
    responseStyle,
    languagePreference,
    shellArmed: isMutatingArmed(caller.platform, caller.conversationId, caller.userId),
  };
}

export type ResumeDecision =
  { sessionId: string; reason: 'resumable' } | { sessionId: null; reason: 'none' | 'cap' | 'prompt-changed' };

/**
 * Whether a stored session may be resumed for this turn.
 *
 * SECURITY: a resumed Agent SDK session keeps the system prompt it was
 * STARTED with and ignores the `systemPrompt` passed on resume (verified
 * against the SDK: a session begun under prompt A and resumed with prompt B
 * still follows A). Sessions are shared per (platform, conversation), so
 * without this check every later speaker in a group ran under the FIRST
 * speaker's prompt: their tier's role note, persona, response style, language
 * preference and date line — the model's picture of who it was talking to was
 * wrong in both directions (an admin told they weren't one; a member framed
 * as an admin).
 *
 * This used to add that tools are chosen per turn, so no capability could
 * leak. That is NOT established: the 0.7.0 arming bug showed a turn whose
 * options granted the full built-in surface behaving as though it had none,
 * which is what a session freezing its tool configuration alongside its
 * prompt would look like. The guarantee does not depend on it either way,
 * because a tier change alters the role note and so the prompt hash. It is
 * also why anything that changes the TOOL surface without changing the prompt
 * must add a prompt slot (see `PromptPolicy.shellArmed`): otherwise it is
 * silently inert on every conversation with a live session.
 * So a session is resumable only while the prompt is byte-identical, which is
 * exactly the prompt-cache precondition anyway. Otherwise the turn starts
 * fresh, with the conversation tail backfilled as quarantined reference.
 * A pre-fingerprint row (null) is never resumed.
 */
export function resumableSessionId(
  stored: StoredSession | null,
  promptHash: string,
  now: number = Date.now(),
): ResumeDecision {
  if (!stored) return { sessionId: null, reason: 'none' };
  const maxAgeMs = config.behaviour.sessionMaxAgeHours * 3_600_000;
  if (stored.turnCount >= config.behaviour.sessionMaxTurns || now - stored.updatedAt.getTime() >= maxAgeMs) {
    return { sessionId: null, reason: 'cap' };
  }
  if (stored.promptHash !== promptHash) return { sessionId: null, reason: 'prompt-changed' };
  return { sessionId: stored.sessionId, reason: 'resumable' };
}

/**
 * Run one agent turn for an incoming message.
 *
 * Pipeline: recall relevant memory -> build a role-scoped system prompt and
 * tool surface -> resume the per-conversation Claude session -> stream the
 * result. Tool access is restricted by RBAC via `allowedTools`, and ALL
 * built-in Claude Code tools (Bash/Read/Write/...) are disabled via
 * `tools: []`, so the model's only capabilities are our MCP tools.
 *
 * `signal` lets a module stop the turn (a person pressing Stop). Once it
 * fires, the running model call is interrupted, the turn resolves `ok: false`
 * with `stopped: true`, an empty `text` and the cost the CLI reported before
 * it stopped, and the failed-resume retry is never started. A signal that has
 * already fired makes no model call at all. See {@link execTurn}.
 */
export async function runAgentTurn(
  caller: CallerContext,
  userText: string,
  adapter: PlatformAdapter,
  getAdapter?: AdapterLookup,
  image?: IncomingMessage['image'],
  signal?: AbortSignal,
): Promise<AgentReply> {
  // Bound the model-bound copy only — this reassigns the local `userText`
  // binding, never the caller's original string (msg.text in router.ts), so
  // archiving/classification/dedup/echo downstream of the router still see
  // the full, untruncated message (issue #811).
  userText = truncateIncomingMessage(userText, config.behaviour.maxIncomingMessageChars);

  // Memory recall is scoped to THIS conversation only. Cross-conversation
  // recall is available solely through the admin-gated tools, so a public
  // channel can never surface someone else's DMs.
  const memories = await searchMemory(userText, {
    platform: caller.platform,
    conversationId: caller.conversationId,
  });

  const codeAnswers = await getCodeAnswersPolicy();
  // getResponseStyle already fails open internally (degrades to 'standard' on
  // a DB error, see repository.ts) — this try/catch is a second, independent
  // backstop for the lookup itself throwing/rejecting (e.g. an injected test
  // double, or a future caller that removes that internal catch), mirroring
  // the languagePreference backstop just below (issue #430 acceptance
  // criterion 5 / #52's fail-open invariant). Unlike languagePreference,
  // there is no "lookup failed" state to preserve here — responseStyle only
  // ever gates a substitution, never gets echoed back on `AgentReply` — so it
  // degrades straight to the 'standard' default rather than staying optional.
  let responseStyle: ResponseStyle = 'standard';
  try {
    responseStyle = await getResponseStyle(caller.platform, caller.userId);
  } catch (err) {
    logger.warn(
      { err, conversationId: caller.conversationId },
      'Response-style lookup failed; degrading to standard',
    );
  }
  // getLanguagePreference already fails open internally (degrades to 'auto'
  // on a DB error, see repository.ts) — this try/catch is a second,
  // independent backstop for the lookup itself throwing/rejecting (e.g. an
  // injected test double, or a future caller that removes that internal
  // catch), so a language-preference fault can never take down the whole
  // turn (issue #52's fail-open invariant). `reply.languagePreference` is
  // left `undefined` in that case rather than coerced to 'auto', so a caller
  // can distinguish "resolved to auto" from "lookup failed" if it ever needs
  // to.
  let languagePreference: LanguagePreference | undefined;
  try {
    languagePreference = await getLanguagePreference(caller.platform, caller.userId);
  } catch (err) {
    logger.warn(
      { err, conversationId: caller.conversationId },
      'Language-preference lookup failed; degrading the code-policy note to English',
    );
  }
  const persona = selectPersona({ text: userText });
  const systemPrompt = buildSystemPrompt(
    caller,
    promptPolicyFor(caller, codeAnswers, responseStyle, languagePreference ?? 'auto'),
    persona,
  );
  // Recalled messages are untrusted user content: they ride in the user turn
  // inside a clearly delimited block, never in the system prompt. The
  // requester's display name rides here too (issue #508, relocated from the
  // system prompt's `Context:` block): keeping it out of the system prompt
  // keeps that string byte-identical across different posters of the same
  // role in the same conversation, which is the real precondition for an
  // Anthropic prompt-cache hit at the system block's trailing breakpoint.
  const memoryBlock = memories.length > 0 ? renderMemoryContext(memories) : '';

  // Session hygiene: cap resumed-session length and age so context (and any
  // accumulated injection) can't grow without bound, and never resume a
  // session that was started under a different system prompt (see
  // resumableSessionId: a resumed session keeps its original prompt).
  const promptHash = systemPromptFingerprint(systemPrompt);
  const stored = await getClaudeSession(caller.platform, caller.conversationId);
  const resume = resumableSessionId(stored, promptHash);
  const priorSession = resume.sessionId;
  if (resume.reason === 'cap') {
    logger.info(
      { conversationId: caller.conversationId, turnCount: stored?.turnCount },
      'Session past turn/age cap — starting fresh',
    );
  } else if (resume.reason === 'prompt-changed') {
    logger.info(
      { conversationId: caller.conversationId },
      'System prompt differs from the stored session (requester tier, persona, preferences or day) — starting fresh',
    );
  }

  // Fresh-session continuity backfill: a turn with no resumable session
  // (first contact, cap rollover above, a role-change/purge-cleared session,
  // or the failed-resume retry below) has lost the in-session conversation
  // history, and semantic recall alone can't reconstruct it — it keys on the
  // CURRENT message text, so a follow-up like "why didn't you do that?"
  // recalls nothing useful and the bot goes amnesiac between two adjacent
  // messages. Quote the conversation's recent tail into the user turn as
  // quarantined reference data (same untrusted framing as recall; a resumed
  // session gets none — its history is already in-session). The tail may
  // racily include the current inbound message (the router records it
  // fire-and-forget before this turn runs) — a harmless duplicate of the
  // message text below, not a correctness problem.
  const tailLimit = config.behaviour.sessionRolloverTailCount;
  const fetchTail = () => recentConversationTail(caller.platform, caller.conversationId, tailLimit);
  const assemblePrompt = (tail: ConversationTailRow[]) =>
    [
      renderRequesterTag(caller.userName),
      tail.length > 0 ? renderConversationTail(tail) : '',
      memoryBlock,
      userText,
    ]
      .filter(Boolean)
      .join('\n\n');
  const prompt = assemblePrompt(priorSession ? [] : await fetchTail());

  const first = await execTurn(
    caller,
    prompt,
    systemPrompt,
    adapter,
    priorSession,
    getAdapter,
    image,
    signal,
  );
  let outcome = first;

  // If resuming a stale/foreign session failed (session files are CLI-local
  // disk state), drop the stored id and retry once with a fresh session so
  // the conversation doesn't brick itself. The retry is a fresh session too,
  // so it gets the same tail backfill the rollover path above does. Never
  // after a Stop: the person asked for nothing more to run, and a retry is a
  // second model call.
  if (!first.ok && first.resumeFailed && priorSession && !signal?.aborted) {
    logger.warn(
      { conversationId: caller.conversationId, priorSession },
      'Session resume failed; clearing stored session and retrying fresh',
    );
    await clearClaudeSessionId(caller.platform, caller.conversationId).catch(() => {});
    outcome = await execTurn(
      caller,
      assemblePrompt(await fetchTail()),
      systemPrompt,
      adapter,
      null,
      getAdapter,
      image,
      signal,
    );
  }

  if (outcome.sessionId) {
    await setClaudeSessionId(caller.platform, caller.conversationId, outcome.sessionId, promptHash).catch(
      (err) => logger.warn({ err }, 'Failed to persist session id'),
    );
  }

  // Select the caller's variant of a fixed failure fallback (issues
  // #396/#430). Gated on `outcome.ok === false` AND on the outcome carrying
  // a `fallbackNoticeId` — never on matching the rendered text — so a
  // genuine model answer can never be rewritten (the #259 "threaded, not
  // string-matched" discipline, now enforced by the type rather than by a
  // comment). Axis precedence (a registered language claims the turn; style
  // applies only otherwise) lives in the catalogue, so both preferences are
  // passed RAW and no locale value is named here.
  const text =
    !outcome.ok && outcome.fallbackNoticeId
      ? notice(outcome.fallbackNoticeId, { language: languagePreference, style: responseStyle })
      : outcome.text;

  return {
    text,
    costUsd: outcome.costUsd,
    cacheReadTokens: outcome.cacheReadTokens,
    cacheCreationTokens: outcome.cacheCreationTokens,
    modelUsage: outcome.modelUsage,
    sessionId: outcome.sessionId,
    ok: outcome.ok,
    maxTurnsExceeded: outcome.maxTurnsExceeded,
    ...(outcome.stopped ? { stopped: true } : {}),
    languagePreference,
    responseStyle,
    turnState: outcome.turnState,
  };
}

// Module-level: the upstream usage-limit condition is a property of the
// shared Max pool, not any one conversation, so the debounce latch is
// process-wide rather than per-conversation (mirrors usageAlert.ts's
// single rolling tracker).
let usageLimitTracker = initialUsageLimitTracker();

// Every registered platform, derived from the platform registry (agent-base
// plan item 9) — this used to be a hand-kept `['discord', 'whatsapp']` copy
// mirroring tools/notify.ts's, back when `Platform` was a closed union.
const ALL_PLATFORMS: readonly Platform[] = KNOWN_PLATFORMS;

/**
 * Debounced super-admin DM when a turn fails on an upstream usage-limit/
 * overload condition (issue #131) — one per ongoing window, silent re-arm
 * once a turn stops hitting it. No-op unless UPSTREAM_LIMIT_ALERT_ENABLED.
 * DMs go out via every connected adapter (issue #325), not just the one that
 * saw the failure — this is a shared-Max-pool condition, so it degrades every
 * platform at once, mirroring `tools.ts`'s `notifySuperAdmins` (#288) and
 * every other sibling alert path (health.ts, usageAlert.ts, backgroundJobs.ts,
 * router.ts). Unlike `notifySuperAdmins`, there is no triggering user to
 * exclude — this is a system-condition alert, not a member-initiated one — so
 * every id in each connected platform's `superAdminIds(platform)` is DMed.
 */
const USAGE_LIMIT_ALERT_MESSAGE =
  '⚠️ The bot just hit an upstream Claude usage-limit/overload condition — members are seeing a ' +
  "degraded reply. This isn't a bug and should clear once the shared quota resets; consider " +
  'pause_bot if it persists.';

function noteUsageLimitOutcome(
  hitUsageLimit: boolean,
  adapter: PlatformAdapter,
  conversationId: string,
  getAdapter: AdapterLookup | undefined,
): void {
  if (!config.behaviour.upstreamLimitAlertEnabled) return;
  const step = stepUsageLimitTracker(usageLimitTracker, hitUsageLimit);
  usageLimitTracker = step.tracker;
  if (!step.shouldAlert) return;
  logger.warn(
    { conversationId, platform: adapter.platform },
    'Upstream Claude usage-limit/overload detected',
  );
  const targets = ALL_PLATFORMS.map((platform) =>
    platform === adapter.platform ? adapter : getAdapter?.(platform),
  ).filter((target): target is PlatformAdapter => target != null && target.isConnected());
  if (targets.length === 0) {
    logger.warn(
      { conversationId },
      'Usage-limit alert could not be delivered live — no connected adapter; queued for flush on reconnect',
    );
    queuePendingAlert(USAGE_LIMIT_ALERT_MESSAGE, 'system'); // super-admin-only alert — never evicted by a member-reachable alert (#545)
    return;
  }
  for (const target of targets) {
    for (const id of superAdminIds(target.platform)) {
      target
        .sendDirectMessage(id, USAGE_LIMIT_ALERT_MESSAGE)
        .catch((err) => logger.warn({ err, platform: target.platform, id }, 'Usage-limit alert DM failed'));
    }
  }
}

/**
 * Wraps a plain-string prompt plus an image attachment into the single
 * `AsyncIterable<SDKUserMessage>` the SDK's `query()` requires for a
 * multimodal turn (issue #783) — `query()`'s `prompt` param is typed
 * `string | AsyncIterable<SDKUserMessage>` (sdk.d.ts), and `SDKUserMessage.message`
 * is the base Anthropic `MessageParam`, whose `content` accepts an array of
 * blocks including an image block. Yields exactly one message so this is a
 * single turn, not a stream of turns. `text` first, image second — reads
 * naturally if the model ever needs to quote the accompanying caption
 * verbatim, and matches this repo's caption-then-image logging convention
 * elsewhere (adminDigest.ts image summaries).
 */
async function* promptStream(
  text: string,
  image: IncomingMessage['image'] | undefined,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: image
        ? [
            { type: 'text', text },
            { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } },
          ]
        : [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
  };
}

/**
 * How long a stopped turn waits, after `Query.interrupt()`, for the CLI's own
 * `result` message before the `abortController` backstop fires. The interrupt
 * is the graceful path: the CLI ends the model call and still reports
 * `total_cost_usd`, which is what the module records as spent. A few seconds
 * bounds a CLI that never answers the interrupt; after the backstop the cost
 * is whatever had arrived, possibly none.
 */
export const STOP_GRACE_MS = 3000;

/**
 * Internal marker for a turn whose module signal fired and whose CLI did not
 * finish within {@link STOP_GRACE_MS} of the interrupt. Like the timeout
 * marker below, never surfaced in a reply.
 */
class AgentTurnStoppedError extends Error {}

/**
 * Internal marker for a turn that never settled within
 * `config.behaviour.agentTurnTimeoutMs` (issue #826). Never constructed from
 * or exposed to model/user-supplied text, and its message is never surfaced
 * in a reply — the catch block below returns the existing, unmodified
 * `INTERNAL_ERROR_REPLY` for it, exactly like any other generic turn failure.
 *
 * RESIDUAL, narrowed but not eliminated (issue #826 review; abort wiring
 * added in #860). `Promise.race` abandons the `for await` loop, and the
 * timeout branch now also calls `abortController.abort()` on the same
 * `query()` call — but per the pinned SDK's own documented contract that
 * abort is forwarded to the CLI subprocess best-effort, after its graceful
 * stdin-EOF close and a short grace window, not instantaneously. So there is
 * still a bounded window, shorter than before #860, in which `router.ts`'s
 * per-conversation queue has unblocked and a NEW turn can start while the
 * orphaned generator has not yet actually stopped and still holds this
 * caller's `toolServer`; if it drives a tool call in that window, it is a
 * genuine (if now much narrower) side effect.
 *
 * Why that residual is tolerable: the orphan runs with the SAME caller's
 * already-resolved tier and tool surface, so it is not a privilege-escalation
 * path — the worst case is duplicated side effects from a turn the member was
 * already told had failed, which is strictly better than the pre-#826
 * behaviour where the wedge blocked that conversation's queue forever with no
 * recovery short of a process restart. `tests/agentCoreTurnTimeout.test.ts`
 * pins both the member-observable part (the reply they received is final and
 * a late completion never races a second reply into the conversation) and the
 * new abort call itself (fires exactly once, only on the timeout path).
 */
class AgentTurnTimeoutError extends Error {}

/**
 * Thrown from inside the SDK message loop when the `init` message advertises
 * none (or not all) of the registered tools this turn was allowed — the
 * signature of a refused tool schema taking the whole server down (WattoBot
 * #105). Caught by `execTurn`'s catch and turned into a logged, `ok: false`
 * turn rather than a toolless answer reported as success.
 */
class ToolInventoryError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly servers: ReadonlyArray<{ name: string; status: string }>,
  ) {
    super(`SDK init advertised none of: ${missing.join(', ')}`);
    this.name = 'ToolInventoryError';
  }
}

// Exported for tests, like `buildQueryOptions`: it is the one place the SDK
// message stream is interpreted, and the #105 inventory check can only be
// proven against a stream.
export async function execTurn(
  caller: CallerContext,
  prompt: string,
  systemPrompt: string,
  adapter: PlatformAdapter,
  resumeSession: string | null,
  getAdapter?: AdapterLookup,
  image?: IncomingMessage['image'],
  signal?: AbortSignal,
): Promise<TurnOutcome> {
  // Stopped before the model was reached: nothing runs and nothing is spent.
  if (signal?.aborted) return { ok: false, resumeFailed: false, text: '', stopped: true };
  // Turn-scoped ref (issue #411): tool handlers write their module's keys
  // into this bag during the turn (agent/communityTurnState.ts documents
  // today's five); finalized back below only on the genuine-success path
  // (never on a thrown-error or non-success result, so a fallback/error
  // reply can never carry a stale correlation). Starts EMPTY — every module
  // key is optional, and the registered finalizer treats absent exactly like
  // the old false/null/[] initializers.
  const turnState: ToolServerTurnState = {};
  const toolServer = buildToolServer(caller, adapter, getAdapter, turnState);
  // Built-in WebSearch runs this turn, reported by the PostToolUse hook
  // buildQueryOptions attaches (WattoBot #100); surfaced on the success bag
  // below under the same absent-not-empty discipline as the module keys.
  const webSearches: BuiltinWebSearchUse[] = [];

  // Text of the assistant message currently being streamed. Reset per
  // assistant message so tool-use narration from earlier turns never leaks
  // into the user-facing reply.
  let lastAssistantText = '';
  let resultText = '';
  let resultSubtype: string | undefined;
  let costUsd: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let modelUsage: Record<string, number> | undefined;
  let sessionId: string | undefined;
  // What a stopped turn resolves to: no text and no fallback notice (the
  // module speaks for a Stop), with whatever the CLI had reported as spent.
  const stoppedOutcome = (): TurnOutcome => ({
    ok: false,
    resumeFailed: false,
    text: '',
    stopped: true,
    costUsd,
    cacheReadTokens,
    cacheCreationTokens,
    modelUsage,
    sessionId,
  });

  // Wall-clock ceiling on the loop below (issue #826): an iteration that
  // never yields and never settles is invisible to the `catch` — only a race
  // against a timer unblocks it. Cleared in `finally` on every settle path
  // (success, thrown error, or timeout) so no leaked timer outlives the call.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  // One AbortController per turn (issue #860), aborted from the timeout
  // branch below. `abortController` is the exact field name the pinned
  // @anthropic-ai/claude-agent-sdk@0.3.220's sdk.d.ts documents on `Options`
  // ("Controller for cancelling the query. When aborted, the query will stop
  // and clean up resources.") — confirmed by
  // tests/agentCoreTurnTimeout.test.ts's .d.ts-pinning test, mirroring the
  // core.ts:450 / tests/agentSkillsEnabled.test.ts precedent, so a future SDK
  // upgrade that renames or drops it fails CI instead of the abort silently
  // becoming a no-op.
  const abortController = new AbortController();
  const options = buildQueryOptions(
    caller.role,
    systemPrompt,
    // Keyed by the module-registered MCP server name (the same name
    // that roots the `mcp__<name>__*` ids in allowedTools) — never a
    // hard-coded literal here in base.
    { [toolServerName()]: toolServer },
    resumeSession,
    caller.conversationId,
    caller.platform,
    caller.userId,
    (use) => webSearches.push(use),
  );
  // The registered tools this turn was allowed: every one of them must come
  // back in the SDK's `init` message, or the server was dropped (WattoBot
  // #105). Intersected with the registry so a tier list naming a tool the
  // module never registered stays that module's own inconsistency, not a
  // refused turn.
  const registeredIds = registeredToolIds();
  const expectedTools = options.allowedTools.filter((id) => registeredIds.has(id));
  // Byte-identical to before when there is neither an image nor a signal:
  // `prompt` stays the plain string. An image attachment (issue #783, gated
  // well upstream of here — see config.discord.image /
  // DiscordAdapter.maybeFetchImageAttachment) needs the single-message
  // async-iterable form, and so does a module signal: `Query.interrupt()` is
  // a control request, documented as supported only in streaming-input mode.
  const turn = query({
    prompt: image || signal ? promptStream(prompt, image) : prompt,
    options: { ...options, abortController },
  });
  // Stop (a module's `signal`): interrupt first, so the CLI ends the model
  // call and still emits its `result` with the cost; the loop below keeps
  // reading and records it. If no result arrives within STOP_GRACE_MS, the
  // abortController is the backstop and the race rejects.
  let stopRequested = false;
  let stopGraceHandle: ReturnType<typeof setTimeout> | undefined;
  let onStop: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onStop = () => {
      stopRequested = true;
      turn
        .interrupt()
        .catch((err: unknown) =>
          logger.warn({ err, conversationId: caller.conversationId }, 'Interrupt on Stop failed; aborting'),
        );
      stopGraceHandle = setTimeout(() => {
        abortController.abort();
        reject(new AgentTurnStoppedError('agent turn stopped'));
      }, STOP_GRACE_MS);
    };
    signal.addEventListener('abort', onStop, { once: true });
  });
  // The stop promise may never be awaited (no signal, or the loop finished
  // first); it must never surface as an unhandled rejection.
  stopped.catch(() => {});
  try {
    await Promise.race([
      (async () => {
        for await (const message of turn) {
          switch (message.type) {
            case 'system':
              if (message.subtype === 'init') {
                sessionId = message.session_id;
                // The CLI emits `init` before its first model call, so refusing
                // here costs no tokens. A registered tool the init does not
                // advertise means the server never attached — on CLI 2.1.274
                // one refused schema (see toolServer.ts REFUSED_SCHEMA_KEYWORDS)
                // does exactly that while still reporting the server connected.
                const advertised = new Set(message.tools);
                const missing = expectedTools.filter((id) => !advertised.has(id));
                if (missing.length > 0) {
                  abortController.abort();
                  throw new ToolInventoryError(missing, message.mcp_servers);
                }
              }
              break;
            case 'assistant': {
              const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } })
                .message?.content;
              if (Array.isArray(content)) {
                const textBlocks = content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text as string);
                if (textBlocks.length > 0) lastAssistantText = textBlocks.join('\n');
              }
              break;
            }
            case 'result':
              if ('session_id' in message && typeof message.session_id === 'string') {
                sessionId = message.session_id;
              }
              if ('total_cost_usd' in message && typeof message.total_cost_usd === 'number') {
                costUsd = message.total_cost_usd;
              }
              if ('result' in message && typeof message.result === 'string') {
                resultText = message.result;
              }
              // Cache-usage telemetry (issue #508): the SDK result message's
              // `usage` exposes real cache-hit/-write counts, so an operator can
              // empirically confirm (and quantify) the prompt-cache benefit the
              // system-prompt relocation above is meant to recover, instead of
              // taking a code-level proxy on faith.
              if ('usage' in message && message.usage && typeof message.usage === 'object') {
                const usage = message.usage as {
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
                cacheReadTokens = usage.cache_read_input_tokens;
                cacheCreationTokens = usage.cache_creation_input_tokens;
                logger.debug(
                  {
                    conversationId: caller.conversationId,
                    cacheReadTokens: usage.cache_read_input_tokens,
                    cacheCreationTokens: usage.cache_creation_input_tokens,
                  },
                  'agent turn cache usage',
                );
              }
              // Per-model cost telemetry (issue #792): the same `result` message
              // already carries `modelUsage`, keyed by the model that actually
              // served each portion of the turn — the only way to confirm the
              // #382/#394 role tiering and #738's fallback model are landing spend
              // where configured, rather than trusting the config on faith. Only
              // `costUSD` is copied (never token counts or `provider`/
              // `contextWindow`); keyed by `canonicalModel` when the SDK provides
              // one so a provider-specific alias doesn't fragment the same model
              // into multiple rows. Left `undefined` (not `{}`) when `modelUsage`
              // is absent or every entry's cost is zero, mirroring cache
              // telemetry's "absent, not zero" discipline.
              if ('modelUsage' in message && message.modelUsage && typeof message.modelUsage === 'object') {
                const entries = message.modelUsage as Record<
                  string,
                  { costUSD?: number; canonicalModel?: string }
                >;
                const reduced: Record<string, number> = {};
                for (const [rawModel, entry] of Object.entries(entries)) {
                  if (typeof entry?.costUSD !== 'number') continue;
                  const model = entry.canonicalModel ?? rawModel;
                  reduced[model] = (reduced[model] ?? 0) + entry.costUSD;
                }
                if (Object.keys(reduced).length > 0) modelUsage = reduced;
              }
              resultSubtype = message.subtype;
              break;
            default:
              break;
          }
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          // Additive to #826's mechanism, not a replacement: the reject below
          // is unchanged, this only also tells the SDK to stop the underlying
          // CLI subprocess. Per the pinned sdk.d.ts (see SpawnOptions.signal
          // above `query`'s own Options.abortController), this is forwarded
          // best-effort — it aborts only after the SDK's own graceful-close
          // path (stdin EOF, then a ~2s grace window), not instantaneously.
          abortController.abort();
          reject(new AgentTurnTimeoutError('agent turn timed out'));
        }, config.behaviour.agentTurnTimeoutMs);
      }),
      stopped,
    ]);
  } catch (err) {
    // A Stop outranks every other reading of the failure: whatever the CLI
    // threw on its way down (the backstop abort, an interrupted stream), the
    // person asked for it.
    if (stopRequested) {
      logger.info({ conversationId: caller.conversationId, costUsd }, 'Agent turn stopped');
      return stoppedOutcome();
    }
    if (err instanceof ToolInventoryError) {
      logger.error(
        {
          conversationId: caller.conversationId,
          missingTools: err.missing,
          mcpServers: err.servers,
        },
        'Agent turn refused: the SDK advertised none of the registered tools it was given — a tool schema ' +
          'was most likely refused and the whole server dropped (#105); answering without tools would be wrong',
      );
      noteUsageLimitOutcome(false, adapter, caller.conversationId, getAdapter);
      return {
        ok: false,
        resumeFailed: false,
        text: notice('internalErrorReply'),
        fallbackNoticeId: 'internalErrorReply',
      };
    }
    if (err instanceof AgentTurnTimeoutError) {
      logger.error(
        { conversationId: caller.conversationId, timeoutMs: config.behaviour.agentTurnTimeoutMs },
        'Agent turn timed out',
      );
      // Never a resume failure and never a usage-limit classification — this
      // is an internal ceiling on wall-clock duration, not something the SDK
      // or CLI reported, so neither heuristic below applies to it.
      noteUsageLimitOutcome(false, adapter, caller.conversationId, getAdapter);
      return {
        ok: false,
        resumeFailed: false,
        text: notice('internalErrorReply'),
        fallbackNoticeId: 'internalErrorReply',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, conversationId: caller.conversationId }, 'Agent query failed');
    // Distinguish an upstream Claude usage-limit/overload condition (issue
    // #131) from a random internal failure — "please try again" is actively
    // misleading when the shared pool is genuinely exhausted. Only inspects
    // the SDK/CLI's own error message, never user-supplied text, and always
    // returns a fixed string (the raw error is never echoed).
    const usageLimitHit = isUsageLimitFailure(msg);
    noteUsageLimitOutcome(usageLimitHit, adapter, caller.conversationId, getAdapter);
    const fallbackNoticeId: FallbackNoticeId = usageLimitHit
      ? config.behaviour.upstreamLimitAlertEnabled
        ? 'usageLimitReplyAdminNotified'
        : 'usageLimitReply'
      : 'internalErrorReply';
    return {
      ok: false,
      // Heuristic: resume failures surface as errors mentioning the session.
      resumeFailed: resumeSession != null && /session|resume/i.test(msg),
      text: notice(fallbackNoticeId),
      fallbackNoticeId,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (stopGraceHandle) clearTimeout(stopGraceHandle);
    if (onStop) signal?.removeEventListener('abort', onStop);
  }

  // Stopped, and the CLI answered the interrupt with its result in time. The
  // result's text (if any) is a half-finished answer and never the reply.
  if (stopRequested) {
    logger.info({ conversationId: caller.conversationId, costUsd }, 'Agent turn stopped');
    return stoppedOutcome();
  }

  if (resultSubtype && resultSubtype !== 'success') {
    logger.warn(
      { subtype: resultSubtype, conversationId: caller.conversationId },
      'Agent turn ended non-success',
    );
    // Non-success results (max turns, etc.) are a distinct, already-clean
    // signal — not the opaque thrown-error path the classifier above targets
    // — but still count as "not a usage-limit failure" for the debounce so a
    // recovering turn re-arms the latch.
    noteUsageLimitOutcome(false, adapter, caller.conversationId, getAdapter);
    // Never surface the raw internal transcript on failures.
    return {
      ok: false,
      // Non-success results (e.g. max turns) are turn failures, not resume
      // failures — those throw during init and are handled in the catch above.
      resumeFailed: false,
      text: notice(resultSubtype === 'error_max_turns' ? 'maxTurnsReply' : 'turnFailedReply'),
      fallbackNoticeId: resultSubtype === 'error_max_turns' ? 'maxTurnsReply' : 'turnFailedReply',
      costUsd,
      cacheReadTokens,
      cacheCreationTokens,
      modelUsage,
      sessionId,
      maxTurnsExceeded: resultSubtype === 'error_max_turns' ? true : undefined,
    };
  }

  noteUsageLimitOutcome(false, adapter, caller.conversationId, getAdapter);
  const text = resultText.trim() || lastAssistantText.trim() || "I don't have a response for that.";
  // Generic replacement for the old five hardcoded conditional spreads: the
  // registered finalizers (agent/communityTurnState.ts) decide which keys
  // surface; an empty bag writes no `turnState` key at all, preserving the
  // absent-not-empty discipline of the fields it replaced.
  const bag: Partial<TurnStateBag> = {
    ...finalizeTurnState(turnState),
    ...(webSearches.length > 0 ? { builtinWebSearches: webSearches } : {}),
  };
  return {
    ok: true,
    resumeFailed: false,
    text,
    costUsd,
    cacheReadTokens,
    cacheCreationTokens,
    modelUsage,
    sessionId,
    ...(Object.keys(bag).length > 0 ? { turnState: bag } : {}),
  };
}
