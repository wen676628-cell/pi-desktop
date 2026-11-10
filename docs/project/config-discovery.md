# External configuration discovery

Read-only scan of configuration other coding agents already keep on disk,
modelled on oh-my-pi's discovery providers. Nothing is migrated, copied, or
rewritten — the report tells the user (and the settings surface, next step)
what exists and where.

## Sources

Project scope (relative to the workspace root):

| Provider | Kind | Path |
|---|---|---|
| agents-md | instructions | `AGENTS.md` |
| claude | instructions | `CLAUDE.md` |
| claude | skills / commands | `.claude/skills`, `.claude/commands` |
| cursor | rules | `.cursor/rules`, `.cursorrules` |
| cline | rules | `.clinerules` (file or directory) |
| windsurf | rules | `.windsurfrules` |
| copilot | instructions | `.github/copilot-instructions.md` |
| codex / opencode | instructions | `AGENTS.md` (deduplicated against agents-md) |
| gemini | instructions | `GEMINI.md` |
| agents-md | mcp | `.mcp.json` (server count) |

User scope (relative to the home directory):

| Provider | Kind | Path |
|---|---|---|
| claude | instructions | `.claude/CLAUDE.md` |
| claude | skills / commands | `.claude/skills`, `.claude/commands` |
| codex | instructions | `.codex/AGENTS.md` |
| gemini | instructions | `.gemini/GEMINI.md` |
| cursor | rules | `.cursor/rules` |
| opencode | instructions | `.config/opencode/AGENTS.md` |

## Output

`discoverExternalConfig({ workspaceRoot, home, maxEntries })` returns entries of
`{ provider, kind, scope, path, entries? }`. `entries` is the file count for a
directory and the server count for `.mcp.json`; plain files leave it undefined.
Duplicate paths (several conventions naming the same `AGENTS.md`) are reported
once. The report stops at `maxEntries` (default 200).

The scanner never parses provider-specific semantics beyond counting MCP
servers: importing or enabling a source stays an explicit user action.

## Entry points

- `pnpm discover:config` — table for the current workspace.
- `node scripts/discover-agent-config.mjs --root <dir> --home <dir> --json` —
  structured report for support and tests.

## Tests

`packages/agent-runtime/src/discover-config.test.ts` covers presence/absence,
directory counts, MCP server counts, user scope, deduplication, and the cap.
