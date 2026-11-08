# ADR 0348: Session storage scope for the shared PI_HOME

- Status: Proposed
- Date: 2026-11-08
- Relates: ADR 0347 (shared PI_HOME), ADR 0137 (retained session panes)
- Spec: `docs/spec/02-architecture/07-shared-pi-home.md` §5 P3

## Context

ADR 0347 makes one directory the source of truth for provider, model and
credential configuration, and P0 already makes Desktop read native pi sessions,
skills, prompts and extensions from that directory. Session history is a larger
question:

- Desktop-owned sessions live in `pi.sqlite` and carry the turn queue, review
  snapshots, transcript paging state, approval records and plugin session scope.
- pi CLI sessions are JSONL files under `PI_HOME/sessions`.
- Desktop can already open and continue a native-pi session through
  `native-pi-session`, but a Desktop-created session never appears to the CLI.

Moving every Desktop session into JSONL would change data ownership, lose the
queue/review/approval invariants unless re-modelled, and require a migration with
rollback. That is not required to make configuration shared.

## Decision

1. **Configuration is shared now (ADR 0347).** Sessions are not part of that
   change.
2. **Native-pi sessions stay shared.** Sessions that originate from
   `PI_HOME/sessions` remain readable and continuable from Desktop, using the
   existing native-pi path.
3. **Desktop-owned sessions remain in SQLite.** They keep the queue, review
   snapshots, approvals and retained-pane behaviour that depend on host-core
   tables. They are not exported to JSONL in this change.
4. **No silent cross-surface claim.** Desktop does not present a merged
   Desktop+CLI session list until a dedicated session-sharing ADR defines
   identity, migration and conflict rules.
5. **UI preferences stay per device for now.** `ui-preferences.json` is reserved
   for a future shared Web/Desktop surface; this change must not write UI state
   into the configuration files.

## Consequences

Positive:

- The risky part of unification (configuration) ships without touching
  transcript or approval data.
- Native sessions remain interoperable exactly as they are today.
- Desktop keeps its richer session semantics (queue, review, approvals).

Costs:

- A session created in Desktop is not visible in the CLI and vice versa, except
  for native-pi sessions.
- A future session-sharing ADR will need a migration and a stable session id
  that both surfaces accept.

## Alternatives considered

- **Move all Desktop sessions to `PI_HOME/sessions` now.** Rejected: requires
  re-modelling queue/review/approval state, a large migration and a rollback
  story; it is not needed to share configuration.
- **Mirror each Desktop turn into JSONL.** Rejected: two writers over transcript
  history, with ordering and truncation conflicts.
- **Read CLI sessions read-only into Desktop.** Acceptable as a later increment,
  but it does not give the CLI the Desktop history and would still need identity
  rules.

## Follow-up

A dedicated ADR must define: session identity, ownership, migration from
`pi.sqlite` transcripts, conflict handling for a file edited on both sides, and
what the CLI sees for Desktop-created work.
