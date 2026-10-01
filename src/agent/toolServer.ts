import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape } from 'zod';
import type { AdapterLookup, PlatformAdapter } from '../platforms/types.js';
import type { CallerContext } from '../auth/rbac.js';
import { getLanguagePreference } from '../storage/repository.js';
import type { ToolServerTurnState } from './turnState.js';
import { runInBackgroundScope, type TurnInfo } from './turnScope.js';
import type { BackgroundStart, BackgroundTurnSpec } from './backgroundTurns.js';
import type { Tier } from '../platforms/types.js';

/**
 * The base tool-hosting kernel (agent-base plan §2): `buildToolServer` owns
 * the MECHANISM — one in-process MCP server per turn, every registered def
 * attached, the per-turn context threaded into every handler — while the
 * module CONTENT (the tool inventory, the context factory, and the MCP
 * server name that roots every `mcp__<name>__*` id) arrives as the manifest's
 * `toolServerParts`, which `createAgent` hands to `registerToolServerParts`.
 * Everything here FAILS CLOSED before registration, matching the tool-tier
 * registry in auth/rbac.ts.
 */

/**
 * What an MCP tool handler resolves to — derived from the SDK's own
 * `SdkMcpToolDefinition` handler signature rather than importing
 * `@modelcontextprotocol/sdk` directly, which is only a transitive
 * dependency of this repo (the same derivation as tools/types.ts's
 * `ToolResult`, kept structural here so the base kernel never imports the
 * community registry's types).
 */
type ToolServerToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

/**
 * The structural slice of a registered tool def this kernel actually needs —
 * name/description/schema for the SDK `tool()` call, the handler, and the
 * read-only annotation. The community registry's richer `ToolDef` (tiers,
 * platform restrictions, feature flags) satisfies this shape; those extra
 * fields are consumed by their own registries, never here.
 *
 * `handler` is declared with METHOD syntax, deliberately: that makes `Ctx`
 * bivariant, so a concrete `ToolServerToolDef<ToolContext>` is assignable to
 * `ToolServerToolDef<unknown>` and a module can therefore satisfy the
 * unparameterised `AgentModule` without a cast (see `AgentModule<Ctx>` in
 * createAgent.ts). The laxity is confined to the type level and costs nothing
 * at runtime: the ONLY caller is `buildToolServer` below, which passes each
 * handler exactly the value this same parts object's `makeContext` returned,
 * so no `unknown` is ever actually handed to a handler expecting a context.
 */
export interface ToolServerToolDef<Ctx> {
  name: string;
  description: string;
  schema: ZodRawShape;
  readOnlyHint: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler(args: any, ctx: Ctx): Promise<ToolServerToolResult>;
}

/** The community-registered parts `buildToolServer` composes per turn. */
export interface ToolServerParts<Ctx> {
  /**
   * The MCP server name — also the `mcpServers` record key core.ts attaches
   * the server under, and the root of every fully-qualified
   * `mcp__<name>__<tool>` id. Module-owned: the base never hard-codes it.
   */
  name: string;
  /** Builds the per-turn context every registered handler receives. */
  makeContext: (
    caller: CallerContext,
    adapter: PlatformAdapter,
    getAdapter: AdapterLookup | undefined,
    turnState: ToolServerTurnState | undefined,
    getLangPref: typeof getLanguagePreference,
    /**
     * Which kind of turn this context is for, and for a background turn its
     * id and the module's tag (agent-base 0.9.0). A module that keys per-turn
     * data by conversation needs it: a background turn shares the live turn's
     * conversation. Optional, so a factory written before it still fits.
     */
    turn?: TurnInfo,
  ) => Ctx;
  /** The declarative tool inventory to attach, in registration order. */
  registry: ReadonlyArray<ToolServerToolDef<Ctx>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registered: ToolServerParts<any> | null = null;

/**
 * JSON Schema keywords the bundled CLI answers by dropping EVERY tool on the
 * SDK MCP server, not the one tool, while still reporting the server
 * `connected` and the turn `success` (WattoBot #105). Each entry was
 * reproduced against @anthropic-ai/claude-agent-sdk 0.3.274 / CLI 2.1.274:
 * `z.record` emits `propertyNames`, `z.intersection` emits `allOf`, and a
 * server carrying either boots with `tools: []`. Unions, literals, enums,
 * nullable, formats, patterns, `catchall`, loose objects, tuples,
 * discriminated unions (`oneOf`), defaults and bounds all survive. The list is
 * a snapshot of that CLI; the per-turn inventory check in core.ts is the
 * invariant that catches whatever a later CLI refuses instead.
 */
export const REFUSED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['propertyNames', 'allOf']);

/**
 * The refused keywords a tool's input schema would carry on the wire, converted
 * exactly as @modelcontextprotocol/sdk converts a zod 4 shape for `list_tools`
 * (`toJsonSchemaCompat`: `z.toJSONSchema(schema, { target: 'draft-7', io:
 * 'input' })` over the `z.object` of the raw shape). Empty means accepted.
 */
export function refusedSchemaKeywords(schema: ZodRawShape): string[] {
  const json = z.toJSONSchema(z.object(schema), { target: 'draft-7', io: 'input' });
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (REFUSED_SCHEMA_KEYWORDS.has(key)) found.add(key);
        walk(value);
      }
    }
  };
  walk(json);
  return [...found];
}

/**
 * Refuse a registry whose schemas the CLI would refuse, at boot, naming every
 * offending tool and keyword — so a deployment cannot start in the state #105
 * describes: every Bot answering with no tools and nothing logged. A schema
 * the converter itself cannot represent is reported the same way, because the
 * MCP server's own `list_tools` would fail on it identically.
 */
function assertSchemasAccepted(registry: ReadonlyArray<ToolServerToolDef<unknown>>): void {
  const offenders: string[] = [];
  for (const def of registry) {
    try {
      const bad = refusedSchemaKeywords(def.schema);
      if (bad.length > 0) offenders.push(`${def.name} (${bad.join(', ')})`);
    } catch (err) {
      offenders.push(
        `${def.name} (schema cannot be converted: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `tool schema refused for ${offenders.join('; ')} — the model API does not accept these JSON Schema ` +
        'keywords and the SDK then drops EVERY tool on the server, silently (agent-base #105). ' +
        'Replace z.record with a z.object of named fields and z.intersection with a merged z.object.',
    );
  }
}

/**
 * Register the tool-server parts, exactly once per process — called by
 * `createAgent` from the manifest's `toolServerParts`. A second registration
 * throws rather than swapping the inventory after boot, matching
 * registerToolTiers/registerPromptSections.
 */
export function registerToolServerParts<Ctx>(parts: ToolServerParts<Ctx>): void {
  // Checked first, and before `registered` is set: a refused registry is the
  // more useful error whatever the process state, and it leaves the process
  // able to register a corrected one.
  assertSchemasAccepted(parts.registry);
  if (registered) {
    throw new Error('tool-server parts already registered — the tool inventory cannot be swapped after boot');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registered = parts as ToolServerParts<any>;
}

/**
 * The fully-qualified `mcp__<server>__<tool>` id of every registered tool —
 * what the SDK's `init` message must advertise back for the server to have
 * actually attached. core.ts compares the turn's allowed subset against the
 * advertised list (WattoBot #105).
 */
export function registeredToolIds(): ReadonlySet<string> {
  const { name, registry } = registeredParts();
  return new Set(registry.map((def) => `mcp__${name}__${def.name}`));
}

/** The registered parts; throws (fails closed) if the tool registry never loaded. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registeredParts(): ToolServerParts<any> {
  if (!registered) {
    throw new Error(
      'no tool-server parts registered — a module must supply `toolServerParts` on its createAgent manifest before a tool server can be built',
    );
  }
  return registered;
}

/**
 * The registered MCP server name — the `mcpServers` key core.ts attaches the
 * built server under. Fails closed like `buildToolServer` itself.
 */
export function toolServerName(): string {
  return registeredParts().name;
}

/**
 * What the turn engine tells `buildToolServer` about the turn, beyond the
 * caller: the live turn's door to start a background turn, or a background
 * turn's own identity and the base functions that stand in for the module's.
 */
export type ToolServerTurn =
  | {
      kind: 'live';
      startBackgroundTurn: (spec: BackgroundTurnSpec) => Promise<BackgroundStart>;
    }
  | {
      kind: 'background';
      id: string;
      tag: unknown;
      /** The base's replacement for the module's `requireConfirm`: it never registers a pending action. */
      requireConfirm: (
        description: string,
        minTier: Tier,
        run: () => Promise<string>,
      ) => ToolServerToolResult;
      /** Asked before every module tool call; a string is the refusal the model gets instead of the call. */
      beforeTool: () => Promise<string | null>;
    };

/**
 * Put the base's per-turn fields on the context the module's `makeContext`
 * returned. Mutation rather than a copy, deliberately: the context is the
 * module's own type (a class, a closure bag), and a copy would lose its
 * prototype and any getter.
 *
 * SECURITY: for a background turn this is an enforcement point, so it fails
 * closed. The module's `requireConfirm` must be replaced and the
 * `startBackgroundTurn` door must be absent, or the turn does not run. For a
 * live turn nothing here may break the turn: a context the base cannot extend
 * (a frozen object, a primitive) simply has no door.
 */
function attachTurn(ctx: unknown, turn: ToolServerTurn): void {
  if (turn.kind === 'live') {
    if (ctx === null || typeof ctx !== 'object') return;
    try {
      Object.assign(ctx, { turnKind: 'live', startBackgroundTurn: turn.startBackgroundTurn });
    } catch {
      // A frozen or sealed context: the live turn runs exactly as before.
    }
    return;
  }
  if (ctx === null || typeof ctx !== 'object') {
    throw new Error(
      'background turn: the module tool context is not an object, so CONFIRM cannot be replaced',
    );
  }
  const target = ctx as Record<string, unknown>;
  target.requireConfirm = turn.requireConfirm;
  target.turnKind = 'background';
  if ('startBackgroundTurn' in target) {
    delete target.startBackgroundTurn;
    if (target.startBackgroundTurn !== undefined) target.startBackgroundTurn = undefined;
  }
  if (target.requireConfirm !== turn.requireConfirm || target.startBackgroundTurn !== undefined) {
    throw new Error('background turn: the module tool context could not be given the base CONFIRM refusal');
  }
}

/**
 * Build the in-process MCP tool server for one agent turn. The tools close
 * over the caller context and the adapter handling this conversation, so
 * RBAC and platform routing are baked in. Layers:
 *  1. The tool list attached to the turn is tier-derived (rbac.toolsForRole).
 *  2. Every privileged tool re-asserts the tier before any side effect.
 *  3. Admin data access is scoped in SQL to conversations the admin is in.
 *  4. Destructive actions require an out-of-band CONFIRM (pendingActions.ts).
 *  5. Everything privileged is audited and alerted to super admins.
 */
export function buildToolServer(
  caller: CallerContext,
  adapter: PlatformAdapter,
  getAdapter?: AdapterLookup,
  turnState?: ToolServerTurnState,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
  attach?: readonly string[],
  turn?: ToolServerTurn,
) {
  const { name, registry, makeContext } = registeredParts();
  const info: TurnInfo =
    turn?.kind === 'background' ? { kind: 'background', id: turn.id, tag: turn.tag } : { kind: 'live' };
  const ctx = makeContext(caller, adapter, getAdapter, turnState, getLangPref, info);
  if (turn) attachTurn(ctx, turn);
  // `attach` (G3): the fully-qualified ids this turn may call. Only those are
  // on the server, so a tool call the CLI sends outside its `allowedTools`
  // finds no such tool. Absent, every registered tool is attached and the
  // CLI's `allowedTools` is the only restriction, as before.
  const allowed = attach ? new Set(attach) : null;
  const defs = allowed ? registry.filter((def) => allowed.has(`mcp__${name}__${def.name}`)) : registry;
  return createSdkMcpServer({
    name,
    version: '2.0.0',
    tools: defs.map((def) =>
      tool(def.name, def.description, def.schema, handlerFor(def, ctx, turn), {
        annotations: { readOnlyHint: def.readOnlyHint },
      }),
    ),
  });
}

/**
 * The function the SDK calls for one tool. A live turn's is the module handler
 * as it always was. A background turn's asks `beforeTool` first (a Stop or the
 * pause flag refuses the call even when the CLI skipped its `PreToolUse`
 * hooks, which a sandboxed CLI may), then runs the handler inside the
 * background scope that `registerPendingAction` refuses.
 */
function handlerFor<Ctx>(
  def: ToolServerToolDef<Ctx>,
  ctx: Ctx,
  turn: ToolServerTurn | undefined,
): (args: unknown) => Promise<ToolServerToolResult> {
  if (turn?.kind !== 'background') return (args) => def.handler(args, ctx);
  return (args) =>
    runInBackgroundScope(turn.id, async () => {
      const refusal = await turn.beforeTool();
      if (refusal !== null) return { content: [{ type: 'text' as const, text: refusal }], isError: true };
      return def.handler(args, ctx);
    });
}
