# Multi-agent — considered, and deliberately deferred

How agents built on this framework would work *together*, written down before
anyone needs it — in the same spirit as
[PHASE-4-PERSONAL-AGENT.md](PHASE-4-PERSONAL-AGENT.md) §8.4's "considered and
deferred": the next person to ask should find the reasoning, not re-derive it.

Nothing in this document is implemented, and nothing here exports a type.
That is the rule ([CLAUDE.md](../CLAUDE.md), issue #10): a seam that does not
run is described in prose, under `planned` at best, because somebody will
build against anything stronger. By [VISION.md](VISION.md)'s ranking of where
proposals come from, everything below is **speculative generality** until a
consumer hits it — last in line, and usually the wrong thing to build. This
page exists so that when a consumer *does* hit it, the design conversation
starts from the invariants rather than from a blank page.

"Multi-agent" means three different things, and they have three different
answers.

---

## 1. Several capabilities in one agent — live, and not multi-agent

`createAgent({ modules: [community, finance, …] })` is the composition story,
and it already works: modules cannot see each other's tables or tools, the
base owns ordering and every enforcement point, and completeness is required
of the composition as a whole.

Named first because it is the answer to most requests that arrive wearing the
words "multi-agent". *"I want my agent to also handle X"* is a second module,
not a second agent — one process, one prompt spine, one tool surface, one set
of enforcement points. Reach for anything below only when the thing that is
actually wanted is a second **trust domain** or a second **deployment**, not a
second capability.

## 2. Sub-agents within one process — a future base seam

A supervisor turn spawning a narrower specialist turn ("research this thread",
"audit this ledger") and folding its result back in. The Claude Agent SDK
supports subagents natively, so the runtime cost of this seam is not the
spawning — it is the enforcement plumbing, which is exactly why it would be
**base-owned** if it is ever built.

Apply the standing test — *could a module get this wrong in a way that
matters?* — and the answer is emphatically yes, three times over:

- **Tool surface.** A subagent's tool list must be derived as a **strict
  subset** of the spawning caller's tier-derived surface, never assembled by
  the module. A module-assembled list is a privilege escalation waiting for a
  typo: the whole reason tier lists are derived rather than hand-maintained
  (SECURITY.md invariant 2) applies doubly to a surface assembled per-spawn.
- **CONFIRM.** A destructive action proposed by a subagent routes through the
  same pending-action flow, executed by the router, confirmed by the human.
  A subagent must never be a way to put distance between a destructive tool
  and its CONFIRM gate.
- **Output and budget.** Everything a subagent produces passes the outbound
  filter before any human sees it, and its spend is accounted to the
  originating caller's budgets. An unmetered inner loop is the pause/budget
  machinery's blind spot.

So the split follows the one idea: the **module registers subagent
definitions as data** — a persona, prompt slot content, a named tool subset —
and the **base owns the mechanism**: spawning, surface derivation,
CONFIRM routing, output filtering, budget accounting.

**Status: not planned, absent a consumer.** Neither community-agent nor the
Phase 4 personal agent needs this; both fit in one turn engine. If a consumer
arrives whose need survives the "is this actually a second module?" question
above, this section becomes the seed of a `planned` entry in
[MODULE-API.md](MODULE-API.md) — which, per the rule, will still export
nothing until it runs.

## 3. Cooperating deployments — the invariants already answer this

Two agents built on this base — say community-agent and a household agent —
wanting to talk to each other. This is the interesting case, and the pleasing
conclusion is that it needs almost **no new base mechanism**, because the
existing invariants compose into a federation posture:

- **Another agent is just another caller, with no special trust.** Agent B's
  platform identity (a WhatsApp JID, a Discord user id) goes in agent A's
  users table with an explicitly assigned tier, exactly like a human's.
  Identity resolves from storage and env, never from message content
  (SECURITY.md invariant 2) — B *claims* nothing; A resolves it. There is no
  "agent handshake" that bypasses RBAC, and there must never be one.
- **A peer's messages are quarantined content.** Text arriving from another
  agent is data to report on, never instructions to follow — the same
  provenance posture Phase 4 applies to email bodies, and for the same
  reason: a compromised or prompt-injected peer must not be able to steer
  your agent. `registerProvenance` / `trustOf` fail closed and already carry
  this.
- **Coordinate through a durable medium, not a live channel.** The one
  multi-agent system this project already operates in production is
  community-agent's development pipeline, where the coordination bus is issue
  labels and the repository itself — shared, inspectable, fail-closed state
  that either side can leave and rejoin. That is the pattern: agents
  cooperate through the platforms and stores they already have, where every
  enforcement point applies, not through a private RPC channel where none do.
- **Do not export tools to a peer.** The obvious shortcut — exposing one
  agent's tool inventory to another as an external MCP server — is the same
  move PHASE-4 §8.4 already declined, for the same four reasons: a tool
  crossing that boundary arrives with no tier, no `readOnlyHint`, no CONFIRM
  path and no audit row. The reasoning holds *more* strongly when the caller
  is an autonomous agent than when it is a human's session. A peer asks in
  language; the receiving agent decides with its own tools, under its own
  gates.

What federation would eventually need is thin and module-shaped, not
base-shaped: a message convention two modules agree on, and an idempotency
story for requests between agents. Neither belongs in base until two real
consumers exist to disagree about it — which, realistically, is after the
Phase 4 agent boots. *"Ask the household agent whether we're free Thursday"*
is the first plausible consumer of this section, and it should arrive as
consumer friction, the way every good base proposal has (issues #9, #10, #11,
#29).

---

## What would change this document

In [VISION.md](VISION.md)'s proposal ranking, in order of how much evidence
each would carry:

1. A consuming repo files an issue that turns out to need §2 or §3 — the
   signal that converts a section here into a `planned` seam in
   MODULE-API.md.
2. The Phase 4 agent boots, making a two-deployment experiment (§3) cheap to
   actually try over the platforms both agents already speak.
3. Nothing. Absent those, this page is the record that the question was asked
   and where the answer starts — and building ahead of it would be exactly
   the speculative surface a base cannot defend.
