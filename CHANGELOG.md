# Changelog

Release notes for `@swampratnz/agent-base`, newest first. Earlier releases are
described in their pull requests and in [docs/MODULE-API.md](docs/MODULE-API.md),
which marks the version each seam went live in.

## 0.9.0

A minor bump: the contract is v0, and this release adds a seam that changes the
documented security posture (SECURITY.md invariant 13, and new text under
invariants 1 and 3). Nothing changes for a module that does not opt in.

### Added

- **Background turns.** A live turn's tool can start a second turn for the
  same person that runs on while the conversation carries on, through
  `ToolContext.startBackgroundTurn(spec)`. The module opts in with the new
  `backgroundTurns` manifest field (`maxConcurrent`, `perKey`, `admit`,
  `onConfirmRequest`); without it every start is refused. See
  [MODULE-API.md § Background turns](docs/MODULE-API.md#background-turns) and
  the [design](docs/design/background-subagents.md).
  - The requester is the live turn's caller by construction. Their tier is
    re-resolved and clamped to the lowest of that, the live turn's tier and any
    narrower tier the module asks for; a guest is refused. Tools derive from
    that tier.
  - A fresh session that never touches the conversation's stored session.
  - Never armed, and never able to register a pending action: the base
    replaces `requireConfirm` in a background turn's context with its own,
    which hands the request to `onConfirmRequest` or refuses.
  - A required cost ceiling passed to the SDK as `maxBudgetUsd`; turn and time
    ceilings clamped to the deployment's maxima; process and per-key caps that
    refuse rather than queue; the module's `admit` hook before any spend.
  - A stop handle, `listBackgroundTurns`, `stopBackgroundTurns`, the pause flag
    checked at every tool call, and `Router.drain` stopping them on shutdown.
  - `onDone` receives the outbound-filtered text, a fenced copy for quoting to
    a later turn, the cost (including spend before a stop), the status and the
    module's tag. The base never feeds a result into another turn.
- `TurnRuntimeRequest` gains `kind` (`'live' | 'background'`), and `id` and
  `tag` for a background turn. Optional in the type, always set by the base.
- `ToolServerParts.makeContext` receives an optional sixth argument, the turn's
  `TurnInfo`. `ToolContext` gains optional `turnKind` and
  `startBackgroundTurn`, both set by the base.
- Config: `BACKGROUND_TURN_MAX_TURNS`, `BACKGROUND_TURN_TIMEOUT_MS` and
  `BACKGROUND_TURN_MAX_COST_USD`, the deployment's ceilings for a background
  turn. Unset, the first two are the live turn's values and the third adds no
  ceiling above the module's required per-turn one.
- The barrel exports `listBackgroundTurns`, `stopBackgroundTurns` and the
  background-turn types.

### Changed

- `registerPendingAction` throws when called from inside a background turn's
  tool handler.
- A Stop whose signal fires while a turn's runtime is being resolved now ends
  the turn before any model call. Previously the turn's abort listener was
  installed after the signal had fired and never heard it.
- `Router.drain` also stops every background turn and waits, inside the same
  timeout, for each to end and for its `onDone` to return.

### Adopting it

1. Add `backgroundTurns: { maxConcurrent, perKey?, admit?, onConfirmRequest? }`
   to your manifest.
2. From a live turn's tool handler, call `ctx.startBackgroundTurn?.(spec)` and
   handle the refusal reasons.
3. Optionally, set `onConfirmRequest` to send a background turn's consequential
   actions to your unattended approval path.
4. If you have a `turnRuntime` resolver, decide what `kind: 'background'`
   gets.
5. Keep your own durable record of each task, and record `result.costUsd`
   against the person the way you record a live turn's cost.
