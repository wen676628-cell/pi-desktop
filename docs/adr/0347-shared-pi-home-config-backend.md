# ADR 0347: One PI_HOME configuration owner for Desktop and CLI

- Status: Implemented candidate (P1/P2); session scope decided in ADR 0348
- Date: 2026-11-08
- Relates: ADR 0002 (pi kernel), ADR 0003 (hybrid runtime), ADR 0004 (no remote gateway in MVP)
- Spec: `docs/spec/02-architecture/07-shared-pi-home.md`
> Format note (2026-11-08): the pi CLI stores providers and models in
> `models.json`, API keys in `auth.json`, and non-secret settings in
> `settings.json`. Earlier drafts of this record borrowed Hermes' `config.yaml`
> / `.env` names; the implementation and the remaining text below refer to the
> pi JSON files.

## Context

Desktop and the pi CLI currently keep two independent configuration stores:

- Desktop keeps providers, credentials and secrets in `~/.pi-desktop` (`pi.sqlite` + the secrets store), and its own sessions, plugins and review state.
- The pi CLI keeps `config`/`models`/`auth`/`settings` and sessions under the agent directory selected by `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).
- The Desktop model importer reads the CLI files **once**, in one direction, and writes the result into its own database. After that the two stores drift.
- The recently landed resolver (`packages/agent-runtime/src/agent-dir.ts`) makes Desktop *read* the same directory for native sessions, prompts, skills and extensions. It does not make configuration a single source of truth: provider/model/credential edits still diverge.

Two writers over two stores cannot be reconciled by copying. A copy loop has last-writer-wins races, silently resurrects deleted providers, and turns credential files into a second live database. Hermes demonstrates the robust shape: one home, a long-lived gateway that is the only writer, and a ConfigBackend seam that owns every config read/write with atomic replacement and version tokens.

## Decision

1. **One home.** `PI_HOME` is `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. It holds `config.yaml` (non-secret settings, providers, models), `.env` (secret values, owner-only), `sessions/`, `skills/`, `extensions/`, `prompts/`, `AGENTS.md`.
2. **One writer.** Rust `host-core` owns the configuration domain. A new `config_backend` module is the only code allowed to read or write `config.yaml` / `.env`. Desktop main and the renderer never touch those files.
3. **Atomic and versioned.** Writes use temp file + fsync + atomic rename. Reads expose a version token (mtime, size, content digest) so caches invalidate after CLI edits. A file watcher turns external edits into host events.
4. **SQLite stays operational.** `pi.sqlite` remains authoritative for transcript, turn queue, review state, plugin state and UI indexes. It stops being authoritative for providers, model bindings and credentials.
5. **Secrets live in `.env`.** Provider keys are environment-style entries in `PI_HOME/.env` with owner-only permissions, matching the CLI. Existing Desktop secrets migrate once; the old store is kept read-only for rollback until the migration is confirmed.
6. **UI preferences are not configuration.** Theme, layout, window state, drafts and per-device UI state live in `ui-preferences.json` next to the home, never in `config.yaml`.
7. **Long-lived backend.** A `pi-host serve` / host-core serve mode outlives the desktop window. Desktop attaches over the existing RPC transport; a later ADR may add remote gateways, mirroring how Hermes attaches to local or remote gateways.
8. **Guardrails.** Lint scripts reject direct `open`/`read_text`/`stat`/YAML dump of `config.yaml` or `.env` outside `config_backend`.

## Consequences

Positive:

- A model or key configured in the CLI is immediately available in Desktop and vice versa, with one writer and no copy loop.
- External CLI edits are observed through version tokens instead of being overwritten silently.
- Secrets stop being duplicated between an encrypted database store and plain CLI files.
- Remote/attached backends become possible without changing the desktop UI contract.

Negative / costs:

- Provider and credential migration is user-visible state; it needs backups and a rollback path.
- Secret handling changes from an encrypted store to owner-only files; `redact_secrets` and log hygiene must cover the new path.
- The host must expose configuration reads/writes and change events over RPC, and the renderer settings pages must stop assuming a direct database-backed provider list.
- A serve mode adds a process lifecycle and single-instance/lock rules.

## Alternatives considered

- **Two-way file/database sync (the rejected default).** Bidirectional copying between `pi.sqlite` and `config.yaml` makes both sides writers; ordering, deletion and secret conflicts have no safe resolution.
- **Read-only CLI import at startup.** Current state, extended. It keeps drift: Desktop edits never reach the CLI.
- **Symlink the SQLite database into `PI_HOME`.** Does not make the CLI able to read it; couples schema migrations to a file the CLI does not understand.
- **Desktop stays authoritative and exports on exit.** A crash or a second window leaves the CLI stale; export-on-exit is not a consistency model.

## Migration and rollout

| Stage | Scope | Exit criteria |
|---|---|---|
| P0 (landed) | Resolve the shared agent directory for sessions, prompts, skills, extensions, AGENTS.md and the importer | `agent-dir` tests and importer tests green |
| P1 | `config_backend` read path in host-core; import providers/models from `config.yaml` + `.env` at startup; version token + watcher | CLI edits appear in Desktop without restart; no Desktop writes yet |
| P2 | Make `config.yaml` + `.env` authoritative for providers/models/secrets; provider CRUD goes through host RPC and writes atomically; one-time migration with backup | Add/edit/delete in Desktop is visible to `hermes`-style CLI reads; rollback restores the previous state |
| P3 | Sessions and UI preferences alignment (separate ADR if session storage changes) | Desktop and CLI session lists share the documented scope |

P2 must ship with: a pre-migration backup, an idempotent migration, a feature flag that keeps the SQLite provider mirror for one release, and an explicit "configuration changed outside Desktop" reload path.

## Acceptance

- Only `config_backend` opens or writes `PI_HOME/config.yaml` and `.env` (enforced by lint).
- A provider added in the CLI appears in Desktop; a provider added in Desktop is readable by the CLI, with no restart and no duplicate rows.
- Deleting a provider on either side removes it once, without resurrection.
- Secrets are never logged, never echoed in RPC diagnostics, and the `.env` file is owner-only.
- Killing the desktop window does not stop the backend; reattaching restores the same configuration and sessions.


