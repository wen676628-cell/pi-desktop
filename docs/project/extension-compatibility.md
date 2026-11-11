# Ecosystem extension compatibility

Probe of real `earendil-works` extensions against the Desktop trusted-extension
kernel, run 2026-11-11 on `origin/main` (1d7da53) plus the fixes in this branch.
Repositories at `pi-review` f1de050, `pi-claude-code` d5b5e04, `pi-voice`
970ef02.

## Method

Each repository was cloned at its default branch and loaded through the Desktop
loader (`packages/agent-runtime/src/extensions/loader.ts`) with the same virtual
modules and reporters the sidecar uses. Every factory was then called with a
recording `ExtensionAPI` proxy. The probe reports: discovery, module load,
factory errors, missing `pi-coding-agent` exports, `pi-tui` stub symbols, and
the API members the factory touched.

Reproduction: clone the extension next to the repo, point `PI_EXT_DIST` at
`packages/agent-runtime/dist`, and run the probe script with the repository
paths. No extension code executes beyond module import and the factory call.

| Extension | Version | Load | Factory | API used | Events |
|---|---|---|---|---|---|
| `pi-review` | 0.1.0 | yes | yes | `on`, `registerCommand` | `session_start`, `session_shutdown`, `session_tree` |
| `pi-claude-code` | 0.1.0 | yes (after fix) | yes | `registerCommand`, `registerProvider` | – |
| `pi-voice` | 0.2.0 | yes (after fix) | yes (after fix) | `on`, `registerCommand`, `registerShortcut`, `registerTool` | `session_start`, `session_shutdown` |

Commands registered: `review`, `end-review`, `claude-code-status`, `voice`,
`voice-settings`, `transcribe`, `voice-onboarding`.

## Fixes required to reach a clean load

1. **`@earendil-works/pi-ai/providers/all`** was not a virtual module.
   `pi-claude-code` imports the provider registry through this subpath at module
   load, so the whole extension failed with `Cannot find module`. The loader now
   maps that subpath (and the `@mariozechner` legacy spelling) to the sidecar's
   `pi-ai` provider-registry module.
2. **Coding-agent shim gaps** hit by `pi-voice` at factory time:
   `getAgentDir` (resolved through the same `PI_CODING_AGENT_DIR` resolver as
   native sessions), `formatSize`, `DEFAULT_MAX_LINES`, and
   `DEFAULT_MAX_BYTES`. Values and formatting match `pi-coding-agent`'s own
   truncate defaults so display output is identical.

Regression test: `runner.test.ts` loads a fixture that imports the provider
registry and the four shim helpers and asserts the factory result.

## Remaining gaps

- **`registerShortcut` is inert.** `pi-voice` registers a capture hotkey through
  it; on Desktop the registration reports an `unsupported_api` diagnostic and
  does nothing, so the voice tools and commands work but the extension's own
  keybinding does not. Wiring extension shortcuts into the configurable
  keybinding registry is a separate change.
- **`session_tree` is deferred.** `pi-review` subscribes to it; the handler is
  accepted but never emitted. The explicit `/review` and `/end-review` commands
  are unaffected.
- **Runtime dependencies.** `pi-claude-code` needs the `claude` CLI at run time;
  `pi-voice` needs its npm dependencies (`transcribe-cpp`, recorder) installed,
  which the Desktop extension dependency installer already supports.
- **Terminal UI members** (`setWidget`, `editor`, overlays, …) remain inert;
  extensions that draw a TUI surface will load but not render it. This is the
  documented compatibility subset, not a regression.
