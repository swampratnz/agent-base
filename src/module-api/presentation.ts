/**
 * Prompt, persona, and string-catalogue contributions. The base owns the
 * system-prompt security spine (untrusted-data rules, authorization note,
 * tool-lockdown invariants) and the assembly ORDER; module sections render
 * below the spine and can never replace it. Assembly must stay byte-stable
 * per (role, policy, persona, day) — prompt-cache hit rates depend on it.
 */
export interface PromptSections {
  /** Who this agent is and who it serves (the product charter). */
  charter: string;
  /** Behaviour guidelines; may reference the module's own tool names. */
  guidelineBullets?: readonly string[];
  /** Web-search authority domains cited as first-party in prompts. */
  webSearchAuthorityDomains?: readonly string[];
  /** IANA timezone for user-facing date grounding (e.g. 'Pacific/Auckland'). */
  timezone?: string;
}

/**
 * A selectable voice. Personas change voice, never permissions — the base
 * enforces that persona text renders below the security section.
 */
export interface Persona {
  id: string;
  name: string;
  voice: string;
  aliases?: readonly string[];
}

/**
 * Deterministic user-facing strings (notices, fallbacks, confirm copy) as a
 * catalogue: the base owns lookup, variant precedence, fail-open-to-default,
 * and debounce; modules supply locale/style packs. Variants are fixed,
 * human-authored strings — never model-translated. The CONFIRM/CANCEL
 * protocol tokens are base-owned literals and are not translatable.
 */
export interface StringsPack {
  /** Language/style axes this pack adds (e.g. language 'mi', style 'plain'). */
  languages?: readonly string[];
  styles?: readonly string[];
  /**
   * noticeId → variantKey → text. variantKey is 'default' or a declared
   * language/style; templates interpolate integers only (injection contract).
   */
  notices: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
