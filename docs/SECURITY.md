# Security — the base spine

This document has two halves:

1. **The runtime spine** — the invariants the framework enforces on behalf of
   every agent built on it, and which nothing a module registers may weaken.
2. **The development pipeline's threat model** — the trust boundaries inside
   the multi-loop agent pipeline that develops these repositories. That
   pipeline lives in `swampratnz/community-agent`'s workflows today, not here;
   §3 is written down in this repo because the extraction plan intends to ship
   it as reusable workflows, and because the same controls apply to any repo
   that adopts it. **This repository ships no reusable workflows** — only
   `ci.yml`, `publish.yml` and the canary.

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

A credential the base does not know about is a credential the DLP layer cannot
redact. Base's own list is hand-written (`src/agent/secrets.ts`'s
`runtimeSecrets()`, reading the config singleton) — every new BASE credential
must be added to that function by hand in the same diff that introduces it. A
module's outward credential is registered via the `AgentModule.runtimeSecrets`
manifest field (per-credential getters, folded into the same list), so a module
that declares its credentials there is covered by the backstop on every send
path; one that does not is not covered at all. See invariant 4.

---

## 2 · Runtime invariants the base owns

These are the non-negotiables the module API is designed around, and they are
live code in `src/`. No contract change and no new registration point may
weaken one by accident — which is the test to apply to a proposed extension
point, not "is it generic?".

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
never route around it.

The redacted value list is the backstop for egress paths nobody thought of,
rather than for the one send site that already redacts. Base credentials are
hand-written in `runtimeSecrets()`; a module contributes its own through
`AgentModule.runtimeSecrets` — per-credential *getters*, re-read on every send
so a rotated token stays covered, with a throwing getter failing the send
rather than letting it out unredacted. See §1 and MODULE-API.md
§ Runtime secrets.

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

`PRE_TURN_SPINE`, in full, because the positions are the invariant:

```
block-list → role-resolution → gated-guest → record-inbound →
confirm-intercept → escalation-confirm → addressed-gate → pause →
rate-limit → daily-budget → auto-answer-reserve → memory-barrier →
auto-answer-thread
```

Three of those adjacencies are load-bearing and named in the code:
`confirm-intercept` runs **before** `addressed-gate`, so a bare "CONFIRM"
works in a group where an unaddressed message would otherwise be dropped;
`pause` runs before `rate-limit`, so a paused user never receives both
notices; `daily-budget` runs after both, so a shed message never pays for a
budget read. Abbreviating the list is how one of those quietly stops being
true.

The list is frozen and there is no registration API that can insert, remove or
reorder a step. Module intercepts **append after the last spine step** — they
never precede any of it — and each returns `'continue'` or `'handled'`: an
intercept that has dealt with a message stops the chain and acts through the
router, rather than returning reply text of its own.

### 8. Non-runtime-controllable research surface

Ingest sources and refresh topics are module **code** — not env, not chat input,
not a policy row. What the agent will go and read must not be steerable at
runtime.

### 8b. Guarded egress (`util/safeFetch.ts`)

Every outbound HTTP request a deployment makes on a **caller-influenced** URL
goes through `safeFetch`. Before it existed the base shipped no fetcher at all,
so each consumer rolled its own and only one of them — a link checker — was
hardened; its guard was private, so the fetchers written afterwards each used a
bare `fetch()`. A framework that owns the security spine but not its own egress
leaves every consumer to re-derive this, which is how it gets got wrong.

What it enforces, all failing **closed**:

- **https only**, and the caller's **host allowlist**, checked *before* DNS —
  a refused host must not even produce a resolver query.
- **Address denylist** on every resolved address: loopback, private, CGNAT
  (tailnet), link-local including `169.254.169.254`, multicast, reserved, and
  the v4-in-v6 forms (`::ffff:169.254.169.254` reaches the same metadata
  endpoint as the bare literal). A host answering with a public *and* a private
  address is refused outright rather than pinned to whichever sorted first.
- **DNS pinning per hop.** Each hop resolves exactly once and the request
  connects to that IP literal via a custom undici connector, with the original
  hostname kept as TLS SNI/`Host`. Checking a hostname and then calling
  `fetch()` does not work: `fetch()` resolves again, so a low-TTL record can
  answer public for the check and private for the request.
- **Redirects are followed manually** (`redirect: 'manual'`) so every hop is
  re-allowlisted, re-resolved and re-pinned. Handing `redirect: 'follow'` to
  the runtime would let it chase a `Location` into a private address unchecked
  — the easiest way to reintroduce SSRF after "adding a guard".
- **Content type from headers** before any body is read, and a **byte cap
  enforced while streaming**. `Content-Length` is an early exit only; it is
  absent on chunked responses and free to lie, so the stream is the
  enforcement.

**Policy is the caller's, enforcement is this module's.** `safeFetch` takes a
`FetchPolicy` and never decides which hosts are reasonable — a framework cannot
know that. There is deliberately no "allow any host" value: `allowHosts` is
required and an empty list refuses everything, so opening the egress surface is
always an explicit act by a deployment.

For the same reason there is no `FETCH_PAGE_ENABLED`: the allowlist **is** the
switch (`FETCH_PAGE_ALLOWED_HOSTS`). A separate flag would admit "enabled with
nothing listed" — a state that then has to be *caught* by a refinement, rather
than one that cannot be written down. One variable cannot disagree with itself.
This matches `HEALTH_PORT` and `DISCORD_ALLOWED_CHANNEL_IDS`, neither of which
carries an `_ENABLED` twin.

This does **not** relax §1's rule that `WebFetch` stays disallowed for every
tier. That ban is not about trust level — the *model* composes the URL, so an
injection can exfiltrate conversation content through a query string. Raising
the tier makes that worse, not better. A deployment wanting admin-facing
fetching builds a tool over `safeFetch`, where the host allowlist is enforced
before the request, the resolved URL can be shown to a human for CONFIRM, and
the call lands in the audit log.

### 9. Auditability

Privileged mutations go through the kernel's audit helper: an audit row plus a
super-admin echo, paired in one place so a domain file cannot implement half of
it.

**Planned:** an `auditActionKinds` declaration per module. It exists only on
the v0 contract type and nothing reads it; the allowlist the audit views filter
by is a fixed constant (`MODERATION_ACTION_KINDS`) that a DB CHECK constrains,
and it is maintained by hand.

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

## 3 · The development pipeline's threat model

**Scope:** this section is about the multi-loop agent pipeline that develops
these repositories, which lives in `swampratnz/community-agent`'s workflows.
Nothing described here runs in this repository — its three workflows are CI,
publish and the canary, none of which is agent-driven. It is written down here
because the plan is to ship the pipeline as reusable workflows from this repo,
and because the controls transfer to any repository that adopts it. Until that
lands, read it as a specification, not as a description of what this repo does.

The pipeline is a supply-chain surface: it runs agents with write access to a
repository, against issue and PR content that is often attacker-writable. The
controls below are structural, and each exists because the failure it prevents
is cheap to cause and expensive to notice.

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

Unlike the rest of §3, this subsection describes **this** repository as well:
the two gate scripts ship in this package and `ci.yml` runs them here.

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

## 4 · A gap the gate could not see (closed)

The invariants above are enforced by code; the code is held in place by tests
whose count `npm run test:security` pins per file. Two of the most load-bearing
enforcement points arrived here with **no test file and no floor entry**, so a
change to either could go green in this repository alone:

| Module | What it decides | Coverage here |
|---|---|---|
| `src/auth/rbac.ts` | tier resolution and the derived per-turn tool surface — invariant 2 | `tests/rbac.test.ts`, `tests/rbacFailClosed.test.ts` |
| `src/agent/outbound.ts` | secret redaction on the last hop before a wire — invariant 4 | `tests/outbound.test.ts` |

The code moved; the tests did not, because they import the consumer's tool
registry and the extraction's selection rule read that as "community test". The
49 + 7 original cases still run in `swampratnz/community-agent` against this
package's code, and the nightly canary is what makes that fact load-bearing
rather than incidental — but a second consumer has no such safety net, which is
what issue #9 was about.

Closed by writing against the **package boundary** rather than copying: the
tier tests register a synthetic tool set through the real `registerToolTiers`
and assert the derivation, so what is pinned here is the mechanism a module
composes with, not one deployment's tool names. Copying was never available —
the originals assert things like "`whats_new` is admin-only", which is the
consumer's claim to make.

**The gate still cannot see this class of gap.** The security floor protects
against deleting cases within a repo. It cannot see a module arriving with no
test file, and it cannot see a file arriving with fewer cases than it left with
— the receiving manifest records whatever shows up as correct. Cross-repo moves
therefore need a name-level diff against the source commit, not a count
comparison.

---

## 5 · Known caveats to carry forward

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
