# ADR: Agent long-term memory (stdio MCP server)

## Status

Accepted — server and tools (#50), switch and pi registration (#51, #56),
host-index `session_search` (#56), and the usage/export/import panel (#57).

## Context

Sessions forget. Every conversation starts from zero context about the user,
the project's conventions, past mistakes, and device-specific facts — even
inside the same project the user has worked in for weeks. Competing shells
have shipped solutions: PiDeck's agent-memory (MIT, documented in
`docs/agent-memory.md` of that repository) provides long-term memory across
pi and ACP sessions via a local stdio MCP server; pi's own ecosystem has the
`pi-hermes-memory` extension for pi-only setups.

The fork is well-positioned to go further than both:

- The desktop already ships a Rust host with SQLite ownership, so the "index
  is a rebuildable mirror" model fits the existing persistence discipline.
- The fork's LSP work and host-owned MCP infrastructure mean a local MCP
  server needs no new ports, tokens, or IPC.
- The multi-backend ADR (`multi-backend-agent-sessions.md`) means memory
  should be backend-agnostic from day one — the PiDeck lesson ("a pi-only
  extension was the M1 mistake") applies directly.

## Decision

Adopt the **PiDeck memory architecture** for the fork, implemented host-side:

### 1. Storage model — Markdown is the truth, SQLite is a rebuildable mirror

```
<dataDir>/memory/
├── MEMORY.md              # global facts (32k chars / 400 entries budget)
├── USER.md                # user profile (32k / 400)
├── STANDING.md            # user-authored standing notes (4k / 40, never injected)
├── failures.md            # lessons, entries prefixed [category] (32k / 400)
├── projects/<projectKey>/MEMORY.md + failures.md
├── devices/<deviceKey>/MEMORY.md   # device-local facts (drive letters, paths), never exported
├── device.json            # {id, name}, generated once on first use
├── tombstones.json        # deletion records so deleted memories don't revive via import
└── agent-memory.db        # SQLite mirror + session index (deletable, self-healing)
```

- Entries are plain-text paragraphs separated by `\n§\n`; any editor can edit
  them. Parsing tolerates blank lines and CRLF.
- `projectKey` derives from the session cwd: `<80-char prefix>-<8-char path
  hash>` — the hash suffix is mandatory (without it `D:/a/b` and `D:/a-b`
  collapse to one key and cross-project memories bleed). Legacy keys migrate
  idempotently at startup.
- Every write lands in Markdown first, then the SQLite mirror reconciles. If
  the index is corrupt, read/write degrade to substring search — nothing is
  lost because the mirror is rebuildable.
- Budgets trim oldest-first; single-entry cap 2000 chars. Trimming is
  observable (`trimmed.{count,oldest}`, `overBudget` in status output).
- Duplicate detection folds whitespace before comparing. Atomic writes
  (temp file + rename) in the same directory.

### 2. Delivery — a local stdio MCP server

Same conclusion as PiDeck's documented trade study: a host-built domain
module can't reach non-pi backends, and a pi-only extension was their proven
mistake. A stdio MCP server is the one shape every backend supports (pi's
built-in MCP `command` form; ACP `session/new` `mcpServers`; future
backends per the multi-backend ADR).

- Fork delta: the server is spawned and supervised by the **Rust host** (or
  the sidecar, per the multi-backend rollout), using
  `ELECTRON_RUN_AS_NODE=1` so `node:sqlite` (FTS5) is available — the same
  launcher the OS-wrapped secret key ADR already secures.
- Config entry point is environment variables only
  (`PIDECK_AGENT_MEMORY_DIR` required — refuse to start without it rather
  than guessing a cwd; `..._CWD`; `..._SOURCES`), matching the no-credentials
  discipline.

### 3. Tool surface (7 tools)

`memory_add` / `memory_replace` / `memory_remove` / `memory_search` /
`memory_get` / `session_search` / `memory_status` — with PiDeck's hard-won
constraints:

- `memory_search` reports `elsewhere` hits (`[{projectId, matches}]` + hint)
  when the current scope has none — empty `hits` must not mean "nothing in
  memory".
- `session_search` cross-backend retrieval over the collected session index;
  empty collection sources return `session-sources-empty`.
- Business errors are MCP `isError: true` with structured
  `{ok:false,error:{code,detail}}` so the model can self-correct; protocol
  errors use JSON-RPC error. A single failed request must not kill the
  server.
- Fork delta: `session_search` indexes the host's own SQLite transcripts
  (already FTS-capable) instead of a separate collection pipeline.

### 4. Session collection

The host already persists every session in SQLite with full message history;
the memory server reads it via a host-supplied read-only view
(`PIDECK_AGENT_MEMORY_SOURCES`), no extra capture pipeline. Message ids are
only session-unique — the mirror uses `rowid` primary key + `(session_id,
msg_id)` unique index (PiDeck's documented lesson: a global key collides
with forked sessions).

### 5. Toggle and registration

Master switch `agentMemoryEnabled`, default **off**; off = nothing
registered, nothing written, identical to pre-feature. On = idempotent
registration into the user's pi MCP config (write only the fork's own entry;
skip and never repair-overwrite a malformed `mcpServers`), visible in
Settings with status/export/import/clear-index. Turning it off removes the
registration but never deletes memory files.

Export/import is a JSON package of Markdown entries (the truth is
hand-editable text, so the package is plain JSON a human can inspect, git,
and prune before re-import).

## Consequences

- The desktop gains cross-session, cross-project, cross-backend memory with
  user-inspectable truth files — no hidden training data, no opaque store.
- Device-local facts stay device-local by construction (separate directory,
  never exported).
- Cost: one more long-lived child process (spawned only when enabled);
  SQLite mirror maintenance; budget-trim edge cases. PiDeck's two years of
  documented lessons cover most edge cases already.
- The master switch defaulting to off keeps the feature opt-in at release;
  flipping the default is a product decision for later.
- The fork's Rust host could alternatively implement the server natively;
  the ADR keeps the PiDeck Node/stdio shape because `node:sqlite` +
  TypeScript reuse is cheaper and the multi-backend ADR needs the same shape
  for ACP anyway.

## Rollout

1. Memory server + storage model + 7 tools behind the off-by-default switch
   (pi registration only).
2. Settings page: status, usage, export/import, clear-index.
3. Session collection wiring into the SQLite mirror + `session_search`.
4. (Post-multi-backend) ACP `mcpServers` handshake wiring.

Each step is independently shippable; step 1 alone is user-visible through
pi sessions.
