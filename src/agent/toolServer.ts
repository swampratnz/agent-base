import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape } from 'zod';
import type { AdapterLookup, PlatformAdapter } from '../platforms/types.js';
import type { CallerContext } from '../auth/rbac.js';
import { getLanguagePreference } from '../storage/repository.js';
import type { ToolServerTurnState } from './turnState.js';

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
) {
  const { name, registry, makeContext } = registeredParts();
  const ctx = makeContext(caller, adapter, getAdapter, turnState, getLangPref);
  // Attach everything; the per-turn allowedTools list (rbac.toolsForRole) is
  // what actually restricts which of these the model can call.
  return createSdkMcpServer({
    name,
    version: '2.0.0',
    tools: registry.map((def) =>
      tool(def.name, def.description, def.schema, (args) => def.handler(args, ctx), {
        annotations: { readOnlyHint: def.readOnlyHint },
      }),
    ),
  });
}
