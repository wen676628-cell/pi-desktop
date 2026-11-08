# 07. Shared PI_HOME and Config Backend

Status: Proposed design for ADR 0347. This document is the implementation
breakdown; the decision and its rationale live in
[ADR 0347](../../adr/0347-shared-pi-home-config-backend.md).

## 1. Goal

Make the Desktop and the pi CLI describe one configuration:

```text
PI_HOME (PI_CODING_AGENT_DIR, else ~/.pi/agent)
├── config.yaml        non-secret settings, providers, model bindings
├── .env               provider keys and other secrets, owner-only
├── sessions/          native pi sessions (already shared after P0)
├── skills/            shared skills
├── extensions/        shared trusted extensions
├── prompts/           shared slash-command templates
├── AGENTS.md          shared global instructions
└── ui-preferences.json  per-machine UI state (never config.yaml)
```

`host-core` is the only writer of `config.yaml` and `.env`. SQLite remains the
owner of transcript, turn queue, review state, plugin state and UI indexes.

## 2. Non-goals

- No remote gateway in this change (ADR 0004 stays in force; the seam keeps a
  `remote` backend possible later).
- No change to the IPC/RPC envelope shape used by the renderer beyond new
  configuration operations.
- No move of session storage in P1/P2. Sessions are covered by P3 and, if they
  leave SQLite, by their own ADR.

## 3. Current state (P0 landed)

`packages/agent-runtime/src/agent-dir.ts` resolves `PI_CODING_AGENT_DIR` with a
`~/.pi/agent` fallback and is used by native sessions, custom system prompts,
prompt templates, `AGENTS.md`, trusted extensions and the Desktop model
importer. Reads are shared; writes are not. Providers, model bindings and
credentials still live in `pi.sqlite` + the secrets store.

## 4. Target architecture

```text
Renderer (settings, provider CRUD)
        │  existing IPC
Electron main (thin orchestrator; no config file access)
        │  Host RPC
host-core
  ├── config_backend (Rust)      ← only reader/writer of config.yaml + .env
  │     ├── read_config() / write_config_keys()
  │     ├── version_token() + cache invalidation
  │     └── file watcher → config/changed event
  ├── providers domain           ← reads/writes through config_backend
  └── SQLite                     ← transcript, queue, review, plugin state, indexes
```

Key invariants:

1. Exactly one writer per file: `config_backend`.
2. Every write is atomic (`temp` + `fsync` + `rename`) and preserves unknown
   keys and comments where the YAML parser allows.
3. A read returns `{ value, version }`; caches key on `version`.
4. External edits (CLI, editor) are detected by the watcher and published as an
   invalidation event; no Desktop process polls and rewrites the file.
5. Secret values are never returned by a list RPC; only `hasSecret`.

## 5. Implementation stages

### P1 — Read path (no writes from Desktop)

Deliverables:

- `crates/host-core/src/config_backend.rs`
  - `read_config_doc()`, `read_env_map()`, `version_token()`,
    `watch_config()`.
  - File backend only; `HERMES_CONFIG_BACKEND`-style selection is out of scope.
- `crates/host-core/src/providers/` reads provider/model entries from
  `config.yaml` first and falls back to the existing SQLite rows for untouched
  profiles.
- New RPC: `config.get`, `config.version`, `config.reload` (read-only) and a
  `config/changed` event.
- Desktop main subscribes to `config/changed` and asks the renderer to refresh
  the provider list.

Exit criteria: editing `config.yaml` in the CLI is visible in Desktop settings
without restarting the app; Desktop still writes nothing.

### P2 — Write path and one-time migration

Deliverables:

- `config_backend` write helpers: `write_config_keys(path, pairs)` and
  `set_env_values(path, pairs)`.
- Provider CRUD (`providers.create/update/delete/setSecret`) routes through
  host-core and writes `config.yaml` + `.env`, then updates the SQLite mirror
  in the same transaction boundary.
- Migration:
  1. backup `PI_HOME` + `pi.sqlite` + secrets store;
  2. copy SQLite providers and secrets into `config.yaml` / `.env` only when
     absent;
  3. keep the SQLite mirror for one release behind
     `config.sharedHome.writeThrough` (default on);
  4. rollback restores the backup and disables the flag.
- A `config.export` diagnostics command never prints values, only key names and
  `hasSecret`.

Exit criteria: add/edit/delete on either side converges; no duplicate rows; a
provider deleted in the CLI does not reappear after a Desktop restart.

### P3 — Sessions and UI preferences

- UI preferences move to `ui-preferences.json` (per machine, not per profile).
- Sessions: decide whether Desktop-native sessions join `PI_HOME/sessions` or
  remain in SQLite. This is a separate ADR because it changes data ownership
  and requires a migration.

## 6. Data and security rules

- `config.yaml` and `.env` are owner-only (`0600` on POSIX; ACL on Windows).
- `.env` values are never logged, included in error strings, or returned by an
  RPC. `redact_secrets` must cover the file path and the `.env` shape.
- The `.env` writer preserves unrelated lines and comments; it never rewrites
  the whole file for one key.
- Provider deletion removes only the keys that provider owns; other providers
  and unknown keys stay.

## 7. Validation

| Level | Test |
|---|---|
| Rust unit | atomic write, version token changes, comment/unknown-key preservation, `.env` line preservation, `.env` permissions |
| Rust integration | CLI edits `config.yaml` → `config/changed` → provider list reflects it; Desktop writes → file content matches; deletion does not resurrect |
| Renderer | provider CRUD still works against the RPC contract; no direct file paths in errors |
| Migration | fresh home, existing home, legacy-only SQLite, CLI-only home, both with conflicts; backup and rollback |
| Lint | reject direct `open`/`read_text`/`stat`/`yaml.dump` of `config.yaml` or `.env` outside `config_backend` |

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Secret duplication during migration | Backup first, copy only missing keys, keep old store read-only for one release |
| External edit while Desktop writes | Version token compare-and-set; refuse and reload on mismatch |
| YAML comments/unknown keys lost | Structural writer that only touches managed keys; round-trip tests |
| Provider identity collisions between CLI and Desktop | Stable per-provider id; migration dedupes by id then by `(baseUrl, apiStyle, model set)` |
| Serve-mode lifecycle | Single-instance lock per home, explicit stop command, no idle shutdown matching Hermes |

## 9. Open questions

1. Should `config.yaml` keep Desktop-only provider metadata (order, enabled,
   aliases) under a `desktop:` namespace, or in SQLite with a stable join key?
2. Do we adopt Hermes' profile model (multiple `config.yaml` under one gateway)
   in the same step, or keep one profile per home for now?
3. Is a `remote` config backend needed before P4, or can it wait for the remote
   gateway ADR?
