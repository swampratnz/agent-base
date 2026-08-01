# Security — the base spine contract

This document will grow into agent-base's full threat model as the runtime is
extracted (Phase 3 of [ROADMAP.md](ROADMAP.md)). Until then it pins the
non-negotiables the module API is designed around, so no contract change
weakens them by accident. The full, battle-tested write-up currently lives in
[`community-agent`'s docs/SECURITY.md](https://github.com/swampratnz/community-agent/blob/main/docs/SECURITY.md).

## Invariants the base owns

1. **Tool lockdown**: built-in Claude Code tools are disabled per turn
   (`tools: []`); `WebFetch` is disallowed for every tier; skills load only
   from code-reviewed local directories under an explicit allowlist, never
   `'all'`.
2. **Identity and tiers**: roles resolve from env-configured super admins plus
   the users table — never from message content. The per-turn tool surface is
   derived from registered `ToolDef.minTier` (+ platform capability +
   feature-flag filtering), and privileged handlers re-assert the tier via the
   kernel.
3. **CONFIRM flow**: destructive tools register a pending action; the router
   deterministically intercepts the out-of-band CONFIRM reply, re-checks the
   tier at confirm time, and executes. Models never execute destructive
   actions directly. CONFIRM/CANCEL tokens are protocol literals — modules
   cannot translate or restyle them.
4. **Outbound filtering**: every send path passes the base outbound filter
   (exact-value secret redaction plus policy). Module string packs and adapter
   text packs supply _content_; they cannot route around the filter. Modules
   register their credentials via `runtimeSecrets` so the DLP backstop covers
   them.
5. **Scoped reads**: admin-facing data access is scoped in SQL to
   conversations the admin participates in; the kernel exposes `callerScope()`
   and module queries must use it.
6. **Quarantined recall**: recalled memory, knowledge entries with quarantined
   provenance, and any external prose render inside untrusted framing.
   Provenance→trust is an explicit per-source registration
   (`ProvenanceTrust`), never inferred.
7. **Fixed router spine**: block → role resolution → gated access → CONFIRM
   intercept → pause → rate limit → budget → serialized turn. Module
   intercepts attach only at declared stages after gating and can short-circuit
   with a reply, never reorder or remove spine steps.
8. **Non-runtime-controllable research surface**: ingest sources and refresh
   topics are module code, not env or chat input.
9. **Auditability**: privileged mutations go through the kernel's `audited()`
   (audit row + super-admin echo); modules declare their action kinds.
