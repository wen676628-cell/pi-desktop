# ADR: Multi-backend agent sessions (pi / DSH / Codex CLI / OpenCode / ZCode)

## Status

Proposed

## Context

PI-Desktop binds every session to one engine — the pi agent runtime inside the
Node sidecar. The desktop's permissions, persistence, work panels, review
surfaces and IPC all assume `DesktopAgentRuntime` (`packages/agent-runtime/src/
runtime.ts`, ~9.8k LOC) is the only backend.

Three other agent ecosystems are now widely used by the same audience:

- **DSH** (DeepSeek Harness) — DeepSeek's official harness; strong in the
  fork's primary audience, with its own sessions, approvals, skills and model
  catalog. PiDeck already embeds it as a `utilityProcess` with zero listening
  ports.
- **Codex CLI** — OpenAI's coding agent, own session store and approval flow.
- **OpenCode** — open-source terminal agent, TUI-first, with its own session
  persistence.
- **ZCode** — the local agent harness this repository is driven by; native to
  the fork's own toolchain and useful for self-hosting/dogfooding.

Each exposes a different protocol surface (stdio JSON-RPC, NDJSON streams, or
a harness library), yet they overlap on what the desktop already models:
project-scoped sessions, streaming turns, tool activity, approvals, history
pagination, and cancellation.

The alternative — switching shells — costs the user everything this fork
builds: host-side permissions, transcripts, review surfaces, remote hosts,
and the plugin system.

## Decision

Introduce a **backend adapter layer** between the desktop's session surfaces
and agent engines, so one project can hold sessions from multiple backends and
the user switches engine per session, not per app.

### 1. `SessionBackend` port (TypeScript, agent-runtime)

Extract the minimal interface the desktop actually consumes today:

```ts
interface SessionBackend {
  readonly id: "pi" | "dsh" | "codex" | "opencode" | "zcode";
  createSession(input: { cwd: string; model?: string; thinking?: string }): Promise<BackendSession>;
  resumeSession(sessionRef: string): Promise<BackendSession>;
  prompt(session: BackendSession, text: string, opts: PromptOptions): AsyncIterable<BackendEvent>;
  abort(session: BackendSession): Promise<void>;
  listSessions(projectRoot: string): Promise<BackendSessionSummary[]>;
}
```

`DesktopAgentRuntime` becomes the first implementation (`pi`). Each new engine
is one adapter module; the desktop never imports engine SDKs directly.

### 2. Host-side normalization

The Rust host keeps owning **pi sessions** exactly as today. For non-pi
backends, the sidecar projects their events into the existing wire shapes
(`UiMessage`, tool-call events, permission requests) so transcripts, review
surfaces and persistence keep working without a host protocol change.
Approvals flow through the existing `toolResolvePermission` gate; each adapter
maps the engine's approval verbs onto the fork's permission levels
(Confirm before changes / Auto review / Full access).

### 3. Adapter requirements per backend

| Backend | Process model | History | Approvals | First milestone |
| --- | --- | --- | --- | --- |
| `dsh` | `utilityProcess` embed, zero ports (PiDeck-proven shape) | DSH native pagination | desktop approval dialog | sessions + turns |
| `codex` | spawn `codex` CLI, stdio protocol | CLI store is source of truth | map to fork permission levels | sessions + turns |
| `opencode` | spawn `opencode` CLI | CLI store is source of truth | same mapping | sessions + turns |
| `zcode` | in-proc or spawned harness | fork-local store | same mapping | dogfood first |

### 4. UI surface

- Session creation: backend picker (pi / DSH / Codex / OpenCode / ZCode) next
  to the model picker; default stays `pi`.
- Session list: backend badge per row (like PiDeck's pi/DSH badges).
- Backend-specific settings pages (paths, CLI detection, install status) under
  Settings, one page per backend — no cross-backend config mixing.

### 5. Non-goals

- No translation between engines' session formats; each backend reads its own
  history natively (import of foreign history is a separate future feature).
- No plugin/extension parity for non-pi backends initially — extensions stay
  pi-only.
- No change to the host wire protocol or storage schema in the first
  milestone; projection happens in the sidecar.

## Consequences

- The desktop becomes engine-agnostic; adopting a new agent is one adapter,
  not a product fork.
- Engine-specific bugs stop leaking across backends; each adapter is tested
  against a fake engine process (the same pattern `macos-release-lane.test.mjs`
  uses stubs for).
- Cost: `DesktopAgentRuntime` must shed its singleton assumptions — the
  largest refactor in this ADR, and the reason `runtime.ts` (9.8k LOC) should
  be split along backend seams first.
- Non-pi sessions will have reduced feature parity at first (no GenUI, no
  computer use, no pi extensions); the UI must degrade honestly.
- Upstream sync risk rises for `runtime.ts` while the refactor lands; mitigate
  by landing the `SessionBackend` extraction as several behavior-preserving
  PRs before adding any new adapter.

## Rollout

1. Extract `SessionBackend` port; `DesktopAgentRuntime` implements it; no
   behavior change (regression: existing full desktop test suite).
2. Backend picker + badge UI, pi-only, behind a settings flag.
3. `zcode` adapter (dogfood, exercises the port with a known-good engine).
4. `dsh` adapter (largest audience value).
5. `codex` + `opencode` adapters.

Each step is independently shippable.
