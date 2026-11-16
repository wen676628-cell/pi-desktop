# ADR: ACP client backend research

## Status

Proposed (research ADR — implementation gated on the multi-backend rollout)

## Context

The desktop binds every session to the pi engine. Competing shells — most
notably PiDeck (1218★, MIT) — treat agent engines as pluggable: PiDeck embeds
DSH natively and acts as a general **ACP (Agent Client Protocol) client**,
connecting 15 external coding CLIs (Claude Agent, Codex CLI, Gemini CLI, Kimi,
Qwen Code, OpenCode, Cursor Agent, Copilot CLI, …) into the same session
interface. Adopting a different agent means changing one option, not changing
the app.

ACP is an open protocol: an agent CLI exposes `initialize`,
`session/new` / `session/load`, and a `session/update` stream over stdio
NDJSON JSON-RPC. The client projects that stream into its own UI and bridges
permission requests back as desktop dialogs (`allow_once` / `allow_always` /
`reject_once` / `reject_always`).

The multi-backend ADR (`multi-backend-agent-sessions.md`) already defines the
`SessionBackend` port; ACP is the highest-leverage second implementation
because one adapter covers many agents instead of one per vendor.

## Decision

Research ACP as the second `SessionBackend` implementation, **after** the
multi-backend rollout lands its first two steps (port extraction + backend
picker). This ADR records the known protocol shape and the fork-specific
risks so the research phase has a starting point; it does not commit to an
implementation date.

### Known protocol shape (from PiDeck's public behavior and docs)

- **Transport**: stdio NDJSON JSON-RPC, one child process per session.
- **Handshake**: `initialize` → `session/new` (re-open: `session/load`, which
  makes the CLI replay its history through `session/update`).
- **Streaming**: `session/update` messages project into the desktop timeline
  (thinking blocks, tool-call cards, todo lists, streaming answer text).
- **Approvals**: CLI permission requests bridge to desktop dialogs with the
  four ACP verbs; a timeout resolves as cancel. Optional bypass maps onto the
  engine's own bypass permission tier.
- **History**: primary source is the CLI's own `session/load` replay; PiDeck
  additionally keeps a projected archive (`userData/acp-sessions`, 2000
  entries / 8 MiB per session, atomic write, corrupt-falls-back-to-empty) so
  history survives a CLI-side loss.
- **Stall guard**: a turn with no output for a threshold first sends
  `session/cancel`; if it still does not settle inside a grace window the
  process is killed and the turn settles deliberately. Thresholds are
  user-configurable.

### Fork-specific research questions

1. **Projection into the host wire**: ACP has no native permission-level
   concept. The adapter must map ACP approval verbs onto the fork's three
   permission levels and route requests through the existing
   `toolResolvePermission` gate — the same mapping the multi-backend ADR
   defines for CLI-based engines.
2. **History projection without a second store**: PiDeck keeps a projected
   archive because its UI owns rendering. The fork's transcripts are
   host-owned SQLite; research whether ACP replay can be projected straight
   into `session.import`-shaped rows (one-time, idempotent) instead of a
   second file store, so restart recovery keeps using the existing outbox.
3. **Delta delivery**: PiDeck's own docs record that ACP replay arrives as one
   full payload and their fix plan is to reuse pi's windowed incremental
   delivery. The fork's transcript delivery is already windowed
   (`upsertFrom` + `windowStart` + tool-result trimming); the research must
   decide whether the adapter buffers replay and feeds it through the same
   windowed path, or delivers full-payload once and lets the existing
   renderer reconcile.
4. **Process lifecycle**: spawn/kill/cwd isolation per session, plus the stall
   guard — map onto the sidecar's existing child supervision rather than a
   parallel supervisor.
5. **CLI detection and install**: PiDeck presets carry npm install metadata
   and only allow install commands enumerated in the preset table. The fork
   should adopt the same restriction (no arbitrary command strings) and gate
   install behind the existing settings UI permission model.

### Non-goals for research

- No implementation in this phase; no wire protocol changes; no new storage.
- No commitment to specific CLI vendors; the preset list is PiDeck's and may
  change.

## Consequences

- If research concludes ACP fits, the implementation is one
  `SessionBackend` adapter plus a settings page — the multi-backend ADR's
  rollout step 5.
- If research finds the projection cannot preserve the fork's permission or
  persistence guarantees, the finding itself is the deliverable: document why
  and keep pi-only.
- Cost: research phase only (reading the ACP spec, PiDeck's public protocol
  notes, and prototyping against one real CLI locally); no product surface
  changes until a follow-up ADR is accepted.
