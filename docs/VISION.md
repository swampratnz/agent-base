# Vision

What this repository is for, what it must never become, and how we would know
it worked.

[ROADMAP.md](ROADMAP.md) says what lands when. This says what the work is
*for*, so that a change can be argued about on more than "does it pass CI".

---

## The one-sentence version

**A second agent should be buildable without touching this repository.**

Everything below is an elaboration of that sentence, and every open question at
the end is a place where it is not yet true.

---

## What this is

The community-agnostic runtime underneath Claude Agent SDK bots: platform
adapters, three-tier RBAC, Postgres + pgvector memory, CONFIRM-gated
destructive actions, outbound secret redaction, background jobs, budgets and
alerting. A specific agent — a community bot, a personal-finance bot — is a
**module**: a manifest of registrations handed to `createAgent`.

It arrived by **extraction, not design**. The runtime ran in production inside
`community-agent` for months before it was a package, which is why it landed
with its tests, its security floor and a pipeline that had already adjudicated
it. That origin is a strength and a specific weakness, and both matter:

- **Strength**: nothing here is speculative. Every enforcement point exists
  because a real deployment needed it, and most were written after something
  went wrong.
- **Weakness**: every seam was drawn against **one** agent. A seam that fits
  one consumer perfectly may be a seam in the wrong place. We do not yet know
  which, and no amount of internal review will tell us — only a second, genuinely
  different agent will.

---

## The one idea

**The base owns mechanism and every enforcement point. A module owns content
and policy.**

The test for which side something belongs on is *not* "is it generic?" It is:

> **Could a module get this wrong in a way that matters?**

If yes, base owns the mechanism and the module registers data into it. That is
why the prompt slot set is closed rather than open, why the CONFIRM tokens are
base-owned literals a module cannot translate, why tier lists are *derived*
from tool registrations rather than maintained alongside them, and why every
registry read fails closed instead of returning an empty list.

A module supplies text; it never supplies a filter. It appends an intercept;
it never reorders the spine. It changes a persona's voice; it never changes
permissions.

---

## Who it serves

| | |
|---|---|
| **Today** | one consumer — `community-agent`, in production |
| **Next** | a second, deliberately unlike the first (Phase 4's personal-finance agent) |
| **Not** | the general public, as a general-purpose bot framework |

The second consumer is the point of the whole exercise. Until it exists, the
module API is a **hypothesis** — and `docs/MODULE-API.md`'s live / partial /
planned marking is an honest ledger of how much of it is still hypothetical.

---

## What it must never become

The valuable half of a vision is the refusals.

- **A framework whose security invariants are configurable.** Tool lockdown,
  identity from storage rather than message content, CONFIRM before destructive
  actions, outbound filtering on every send, SQL-scoped admin reads, quarantined
  recall, the frozen router spine. A module may not weaken one, and neither may
  a flag. See [SECURITY.md](SECURITY.md).
- **A plugin marketplace.** Registration is a compile-time act by a repository
  someone owns and reviews, never a runtime load of third-party code.
- **A home for anyone's content.** No community charter, no personas, no te reo
  strings, no knowledge sources. The moment this repository knows a deployment's
  timezone, it has stopped being a base.
- **Generic at the cost of being useful.** This is opinionated on purpose:
  Postgres + pgvector, the Claude Agent SDK, three tiers, one notice pack per
  process. Supporting every database and every model would produce a framework
  that decides nothing and therefore prevents nothing.
- **A thing where merge means ship.** The tag is a deliberate human act, and
  `publish.yml` refuses a real publish from anything but a version tag. No
  automation may relax that.

---

## How we would know it worked

Falsifiable, roughly in order of how much they would tell us:

1. **A second agent reaches production without a change to this repository.**
   The single strongest signal. Phase 4 exists to try it.
2. **The seams marked `partial` and `planned` in
   [MODULE-API.md](MODULE-API.md) shrink**, and shrink because a real consumer
   needed them — not because they were tidy to build.
3. **"I had to change base to build a module feature" trends to zero.** Each
   occurrence is a seam in the wrong place, and is worth recording as such.
4. **A consumer can install and boot it on a machine nobody anticipated** — any
   supported npm, any supported Node, Linux or macOS or Windows. Cheap to
   measure, and historically where the real defects were: see
   [PIPELINE.md](PIPELINE.md), where every defect that reached a published
   artifact was in build/release machinery and invisible to a green CI run.
5. **A cold session can navigate it from `docs/agents/` alone.** The context
   pack is gated for this reason.

---

## What decides what gets built

Proposals for this repository come from four places, and the ordering is
deliberate — it is roughly "how much evidence is behind this":

1. **Consumer friction.** An issue in a consuming repo that turns out to be a
   base problem. The strongest signal there is, because someone hit it while
   trying to do something else. Issues #9, #10, #11 and #29 all arrived this
   way.
2. **The contract-vs-code gaps** — anything `MODULE-API.md` still marks
   `partial` or `planned`, weighted by whether a consumer has actually asked.
3. **Release-confidence gaps** — a way the package can break that nothing would
   catch. [PIPELINE.md](PIPELINE.md) Layer 1 is the standing list.
4. **Speculative generality.** Last, and usually the wrong answer before a
   second consumer exists.

This is deliberately *not* a feature backlog like a product's `VISION.md`. A
framework's roadmap is mostly other people's problems, and inventing extension
points nobody has asked for is how a base grows surface it cannot defend.

---

## Open tensions

Named because they are unresolved, not because they are settled:

- **v0 stability vs. moving fast.** A breaking change is a minor bump while the
  major is `0`, and there have been two in one day (`0.2.0`, `0.3.0`). That is
  right for now and will stop being right the moment a consumer exists that we
  do not control.
- **How much should base own?** Every invariant moved into base is one a module
  cannot get wrong, and one less thing a module can shape. The "could a module
  get this wrong in a way that matters" test is the current answer, and it is a
  judgement call every time.
- **WhatsApp coupling.** Baileys is what a real deployment runs, and it drags a
  git-protocol dependency that npm 12 refuses. It is an optional peer now
  (#29), so the cost follows the feature — but a provider that cannot be
  installed by current npm is a standing liability, not a solved problem.
- **One consumer is not a sample.** Nearly everything in
  `MODULE-API.md`'s closing table records a place where the implementation beat
  the plan. That is reassuring about the code and says nothing about whether
  the seams are in the right places for an agent that is not a community bot.
