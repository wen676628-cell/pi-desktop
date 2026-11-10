# Sticky rules

Always-apply policy files that stay in context for the whole session, modelled
on oh-my-pi's `RULES.md`. Unlike `AGENTS.md`, a sticky rule is not repository
prose that compaction may summarize away: the instruction chain is rebuilt into
the system prompt on every turn, so the rule keeps its hold after the visible
conversation grows.

## Locations

| Scope | Path | Notes |
|---|---|---|
| User | `PI_HOME/RULES.md` (`~/.pi/agent/RULES.md` by default) | Follows `PI_CODING_AGENT_DIR` like the rest of the agent directory |
| Project | `<workspace>/.pi/RULES.md` | Read through `realpath`; a link that leaves the workspace is ignored |

An empty or missing file contributes nothing. Both files are optional and
independent.

## Precedence and budgets

The chain ends with the rule files:

1. `PI_HOME/AGENTS.md`
2. project `AGENTS.md` chain (root → target directory)
3. `PI_HOME/RULES.md`
4. `<workspace>/.pi/RULES.md`

Later entries win a conflict, so a project rule outranks a user rule, and rules
outrank repository instructions. Each family has its own budget — 32 KiB for
global instructions, 32 KiB for the project chain, 16 KiB per rule file — so an
oversized `AGENTS.md` can never evict the policy and vice versa. A cut is
announced in the text (`[PI-Desktop truncated …]`), never silent.

## Implementation

- Loader: `packages/agent-runtime/src/project-instructions.ts` —
  `loadStickyRules`, `globalRulePath`, `projectRulePath`.
- Chain: `loadInstructionChain` appends the rules after the project entries; a
  caller that overrides the global instructions path gets the sibling
  `RULES.md` from the same directory, which keeps tests and profiles isolated
  from the machine's real `PI_HOME`.
- Rendering: `projectInstructionsPrompt` labels each entry with its source, so
  the model sees `## ~/.pi/agent/RULES.md` and `## .pi/RULES.md` next to the
  `AGENTS.md` entries.

## Tests

`packages/agent-runtime/src/project-instructions.test.ts` covers ordering,
missing files, truncation, and the chain position.
