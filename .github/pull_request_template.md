<!--
Fill in the three sections below. Keep them scoped to the diff itself —
do not paste secrets, tokens, env values, or hostnames here.
-->

## Summary

<!-- What changed and why, in a sentence or two. -->

## Security / privacy impact

<!-- Any effect on the invariants in docs/SECURITY.md: tool gating, the CONFIRM
     flow, outbound filtering, data access scope, the router spine order, or
     the pipeline's trust boundaries. If none, say so explicitly.

     If this diff documents a base↔module seam, say whether docs/MODULE-API.md
     is still true against community-agent's real code. -->

## How verified

<!-- Reminder — the full gate, which CI runs too:

     npm run typecheck && npm run lint && npm run format:check \
       && npm test && npm run build \
       && npm run context:check && npm run test:security

     Note anything you verified by hand, and anything you could not verify
     here (e.g. a change that only the extraction pass can exercise). -->
