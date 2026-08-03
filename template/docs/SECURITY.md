# Security design — my-agent

TODO: replace `my-agent`, then work through each section.

The **base invariants are inherited and not restated here** — read
agent-base's `docs/SECURITY.md` for tool lockdown, tier resolution, the CONFIRM
flow, outbound filtering, SQL scoping, quarantined recall, the fixed router
spine and auditability. Nothing in this repo may weaken one of them.

What belongs in *this* file is everything specific to this deployment.

## Assets to protect

TODO. Be concrete: which credential grants what, which data is PII, what
authority the bot holds on each platform, and who can revoke each one.

## Per-tool risk notes

TODO. One entry per tool that can act rather than read: what its blast radius
is, why its `minTier` is what it is, whether it is CONFIRM-gated, and what an
injected turn could at most achieve if it called it.

The useful shape, from the reference implementation, is *threat → controls*
rather than a feature list — and it names the control that would have to fail,
not just the ones that exist.

## New inputs, egress and trust boundaries

TODO. Anything this agent reads that it did not author (uploads, webhooks,
search results, ingested documents) and anything it can send outward. For each:
where it is quarantined, and what stops it being treated as an instruction.

## Residual risks (accepted, documented)

TODO. The point of this section is that an accepted risk is *written down*.
An undocumented one is indistinguishable from an unnoticed one.

## Operational checklist

TODO. Credential rotation, what to do if a token leaks, how to pause the bot,
who gets alerted.
