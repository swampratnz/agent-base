# Architecture — my-agent

TODO: replace `my-agent`, then fill in.

The runtime shape is agent-base's, documented in its `docs/ARCHITECTURE.md`:
adapter → router spine → turn engine → tool kernel → outbound filter. Do not
restate it here.

What belongs in this file:

## What this agent does

TODO. The subsystems that are yours, and what each is for.

## Data model

TODO. Your tables, and which of them hold user data — every one of those must
appear in the module's purge contributor, or the erasure promise is a lie.

## Module registrations

TODO. What `src/module/index.ts` registers and why: tools and their tiers,
jobs and their cadence, prompt sections, policy keys, string packs.

## Deployment

TODO. Where it runs, what it needs, how it is restarted.
