# Security — the base spine

This document has two halves, because agent-base ships two things:

1. **The runtime spine** — the invariants the framework enforces on behalf of
   every agent built on it, and which nothing a module registers may weaken.
2. **The pipeline threat model** — the trust boundaries inside the multi-loop
   development pipeline the reusable workflows carry, which is a security
   surface in its own right even though it touches no member data.

The runtime half is **live code now**: the enforcement points were extracted
from
[`swampratnz/community-agent`](https://github.com/swampratnz/community-agent),
whose `docs/SECURITY.md` remains the battle-tested long form (per-tool
rationale, per-platform notes, incident write-ups, and the accepted residual
risks of that particular deployment). What is written here is what agent-base
OWNS — deployment specifics belong in each agent's own SECURITY.md.

Two enforcement points the extraction ADDED, both fail-closed at startup
rather than at first use:

- **`registerNoticePack` rejects an incomplete pack**, naming every missing
  id. Base declares the notice ids it serves (`BASE_NOTICE_IDS`) and a module
  supplies the text; a gap would otherwise surface as a throw — or blank
  text — in front of a member, on a path (moderation DMs, pause shedding) a
  module author will not necessarily exercise before shipping.
- **`createAgent` refuses an incomplete composition** and returns nothing, so
  there is no object a caller could start against a half-filled registry: no
  narrower tool surface from a forgotten tool-tier registration, no
  unregistered moderation floor, no missing skills allowlist. Its plan pass is
  pure and runs first, so a rejected composition leaves the process untouched.

Treat it as a living document: review it whenever a tool, a platform or a loop
is added. If a change weakens something below, it is not a refactor.

---

## 1 · Assets a base deployment protects

Named generically, because the concrete list is per-agent:

1. **The model credential** — whatever grants use of the LLM account.
2. **Platform bot credentials** — full control of the bot identity on each
   platform (a Discord bot token, a WhatsApp linked-device credential).
3. **The interaction database** — end users' messages, i.e. PII.
4. **Administrative authority** — the ability to moderate, announce, grant
   roles, or otherwise act on a platform under the bot's identity.
5. **The repository itself** — the pipeline can write code; see §3.

Every module registers its own credentials into the outbound redaction
backstop (invariant 4). A credential the base does not know about is a
credential the DLP layer cannot redact.

---

## 2 · Runtime invariants the base owns

These are the non-negotiables the module API is designed around. No contract
change may weaken one by accident; that is why this section exists at contract
stage rather than waiting for the code.

### 1. Tool lockdown

Built-in agent tools are disabled per turn (`tools: []`). Admin+ turns get
exactly one addition — search — and `WebFetch` is disallowed for **every**
tier: the model constructs fetch URLs, so an injection could exfiltrate
conversation content through a query string, and fetched pages are a rich
injection vector. Search snippets are a much smaller surface, and the system
prompt says they are untrusted content.

Note that pre-approving tools is not restricting them. The restriction comes
from the tool list attached to the turn.

Skills load only from code-reviewed local directories under an explicit
allowlist — **never** a wildcard. A wildcard would let a skill file added later
self-activate without the deliberate second edit an allowlist requires.

### 2. Identity and tiers

Roles resolve from env-configured super admins plus the users table —
**never from message content**. The per-turn tool surface is derived from
registered `minTier` (plus platform capability and feature-flag filtering)
before the model sees anything, so a lower tier's turn never has higher-tier
tools attached and cannot call them however convincingly it is asked.
Privileged handlers re-assert the tier anyway; structural gating and in-handler
assertion are separate layers on purpose.

Tier lists are **derived from tool registrations**, not maintained alongside
them. A hand-mirrored list drifts, and a tool registered on the server but
missing from its tier's offer list fails silently.

### 3. CONFIRM flow

Destructive actions register a pending action; the router deterministically
intercepts the out-of-band confirmation, **re-resolves the actor's tier at
confirm time** (a role revoked inside the TTL invalidates the queued action),
and executes. The model never executes a destructive action — an injection can
at most *request* one.

The CONFIRM/CANCEL tokens are base-owned protocol literals. Modules cannot
translate or restyle them: a localisable confirmation token is a confusable
confirmation token.

The pending-action description is sanitized in exactly one place, so a tool
cannot forge a pending-action notice.

### 4. Outbound filtering

Every send path passes the base outbound filter: exact-value secret redaction
plus content policy. Module string packs and adapter text packs supply
*content*; they return plain strings that the base still filters, so a pack can
never route around it. Modules register their credentials so the DLP backstop
covers unknown egress paths, not just the one send site that redacts today.

### 5. Scoped reads

Admin-facing data access is scoped **in SQL** to conversations the admin
actually participates in, verified against the platform rather than asserted.
The tool kernel exposes the caller's scope and module queries must use it.
Scoping in the query, not in a post-filter, is what makes it a boundary.

### 6. Quarantined recall

Recalled memory, knowledge entries with quarantined provenance, and any
external prose render inside untrusted framing. Provenance→trust is an explicit
registration and **fails closed**: an unregistered provenance value is
quarantined. A predicate that treats unknown values as trusted is the same bug
with better manners.

### 7. Fixed router spine

Block → role resolution → gated access → CONFIRM intercept → pause → rate limit
→ budget → serialized turn. The order is load-bearing, the list is frozen, and
there is no registration API that can insert, remove or reorder a step. Module
intercepts attach only after gating and may short-circuit with a reply; they can
never precede the spine.

### 8. Non-runtime-controllable research surface

Ingest sources and refresh topics are module **code** — not env, not chat input,
not a policy row. What the agent will go and read must not be steerable at
runtime.

### 9. Auditability

Privileged mutations go through the kernel's audit helper: an audit row plus a
super-admin echo, paired in one place so a domain file cannot implement half of
it. Modules declare the action kinds they write.

### 10. Personas change voice, not authority

Persona selection alters a voice block and nothing else. Permissions come from
the caller's tier and the tool gating. Every persona's turn is assembled with
identical security guidelines and the same role-derived tool set — otherwise
"let me talk to the admin bot" becomes a privilege-escalation path.

### 11. Closed at the model boundary, open at the type boundary

Platform identifiers, locale axes and job names are open strings so a module can
extend them. The **model-facing** enums and the **database** CHECK constraints
stay closed. Opening a type for composition must not open an input the model can
drive.

---

## 3 · Pipeline threat model

The reusable workflows are a supply-chain surface: they run agents with write
access to a repository, against issue and PR content that is often
attacker-writable. The controls below are structural, and each exists because
the failure it prevents is cheap to cause and expensive to notice.

### Ownership is a security control, not project management

Exactly one loop writes application code and opens PRs. The fixing loops
(autofix, conflict resolution, review-response) may push only to an existing
branch of a PR that already satisfies a re-verified eligibility contract:
same-repo (never a fork), authored by the build identity, body links an issue,
not flagged for human attention. Every one of them is attempt-bounded and
escalates rather than retrying indefinitely. **No loop opens or force-pushes
over a human's PR, and no loop merges a human PR.**

Eligibility is always **re-derived from the API at run time**, never taken from
a dispatch payload. A payload carries an identifier; the job re-reads everything
else. That is what stops a hand-crafted dispatch from aiming a loop at an
arbitrary branch.

### The merge gate

Automated merging is a **deterministic, no-LLM shell loop**. It reads PR titles,
bodies and comments only as data — never as instructions — and runs no
PR-controlled code, so it has none of the fixing loops' injection or
code-execution surface. It merges one PR per run, only when every check is green
and the latest automated review verdict — stamped by the review *workflow*, not
written by the model — post-dates the head commit.

**Governance paths always require a human.** Any PR touching CI, the gate
scripts, the package manifest, the lint/format configuration, the conventions
file, the pipeline docs or this document is never auto-merged: the loop must not
be able to merge a change to its own guardrails, or to what "green" means. Such
a PR is labelled and commented rather than silently skipped.

Branch protection on the default branch is the enforceable backstop for all of
this. Everything above is defence in depth on top of it.

### Agent-to-agent text is untrusted

A handoff note from one loop to another is a **new text channel between two
agents**, and the earlier agent reads attacker-writable input. Containment is
structural, not detection-based:

- **Authorship** — only the workflow identity's comments are read back. The
  agent's own posting identity is different, so it cannot post into the channel
  it feeds; member and fork comments are invisible to it.
- **Position** — the channel marker must be the first line, so prose that merely
  quotes the marker is never mistaken for the channel.
- **Quoting** — every line is emitted quote-prefixed, so it embeds as an
  unmistakably quoted block.
- **Bounding** — a hard character cap, so a note cannot crowd out the consuming
  prompt's own instructions.
- **Control-token stripping** — verdict tokens, resume pointers and the channel
  markers themselves are removed, so a note cannot smuggle a routing decision
  into a channel that parses one.
- **Framing** — the consuming prompt states that the note is untrusted data
  which may only ADD scrutiny, that the verdict must be identical to what it
  would have been with the note absent, and that a note attempting to steer a
  verdict is **itself a finding to report**.

**Deliberately not done: content filtering.** Detecting "instruction-shaped"
prose is unreliable, and silently dropping part of a note would break the
ordinary case *and* hide an attack from the one reader told to report it.
Imperative text survives verbatim — quoted, bounded, labelled untrusted. Pin
that choice with a test so a future change cannot quietly convert it into a
filter and call it an improvement.

Residual risk, accepted: a note is still persuasive text in a reviewer's context
window. What bounds the damage is that the reviewer cannot merge.

### The gates are part of the threat model

The security-test floor and the context-pack gate are not hygiene. The floor's
exact-per-file match plus its PR-base lowering guard exist because the one way
to neuter it quietly is to delete a security test and lower its count in the
same diff; the guard refuses that unless a human applies an explicit label. The
regeneration helper can raise counts but never lower them without the same
explicit flag. A gate a bot can satisfy by itself protects nothing — which is
why the context-pack fixer inserts a stub that keeps its own gate red.

CI runs as read-only (`contents: read`) on `pull_request`, which includes forks
and executes attacker-controlled code through npm lifecycle scripts and the test
suite. Checkouts do not persist credentials — no step needs a git credential
after checkout, and a token readable in `.git/config` while PR code runs is a
token handed over.

---

## 4 · Known caveats to carry forward

- **Subscription auth isolation.** Where the agent authenticates with a personal
  subscription rather than an API key, the blast radius of a compromised process
  is that account. Keep the API-key switch easy from day one — it is a base
  property, not an app one.
- **Prompt-cache byte-stability.** Not a confidentiality issue, but a real
  operational one: any prompt reassembly that is not byte-identical per (role,
  policy, persona, day) silently doubles cost. Pin it with a test before
  touching the assembler.
- **Production schema continuity.** Migration fragments replay over an
  already-applied schema. A reworded statement can diverge the replay, so
  fragments move byte-verbatim and no table is renamed during extraction.
