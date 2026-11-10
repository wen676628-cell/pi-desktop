import { readFile, realpath } from "node:fs/promises";
import { resolveAgentDir } from "./agent-dir.js";
import { isWithinRoot } from "./path-containment.js";
import { dirname, join, relative, resolve } from "node:path";

const INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  join(".claude", "CLAUDE.md"),
];
// The global file and the project chain have independent budgets so an
// oversized global file can never starve project instructions.
const MAX_GLOBAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_PROJECT_INSTRUCTION_BYTES = 32 * 1024;
// Sticky rules are policy, not repository prose: they get their own budget so
// a large AGENTS.md cannot evict them, and vice versa.
const MAX_GLOBAL_RULE_BYTES = 16 * 1024;
const MAX_PROJECT_RULE_BYTES = 16 * 1024;
const STICKY_RULE_FILE_NAME = "RULES.md";

export type ProjectInstruction = {
  source: string;
  content: string;
};

export type ProjectInstructions = {
  entries: ProjectInstruction[];
};

export function globalInstructionPath(): string {
  return join(resolveAgentDir(), "AGENTS.md");
}

/** User-level sticky rules live next to the global instructions. */
export function globalRulePath(): string {
  return join(resolveAgentDir(), STICKY_RULE_FILE_NAME);
}

/** Project-level sticky rules live in the same `.pi` directory as other state. */
export function projectRulePath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".pi", STICKY_RULE_FILE_NAME);
}

/**
 * Load the always-apply rule files.
 *
 * Sticky rules are rebuilt into the system prompt on every turn, so unlike
 * `AGENTS.md` entries they survive compaction instead of being summarized away.
 * User rules come first, project rules last: the narrower scope wins a
 * conflict, matching the project instruction chain.
 */
export async function loadStickyRules(
  workspaceRoot?: string | null,
  options: {
    globalPath?: string;
    maxGlobalBytes?: number;
    maxProjectBytes?: number;
  } = {},
): Promise<ProjectInstructions | undefined> {
  const entries: ProjectInstruction[] = [];
  try {
    const content = (await readFile(options.globalPath ?? globalRulePath(), "utf8")).trim();
    if (content) {
      entries.push(
        limitInstruction("~/.pi/agent/RULES.md", content, options.maxGlobalBytes ?? MAX_GLOBAL_RULE_BYTES)
          .entry,
      );
    }
  } catch {
    // A missing user rule file is the normal first-run state.
  }

  const root = workspaceRoot?.trim();
  if (root) {
    const resolvedRoot = resolve(root);
    try {
      const file = projectRulePath(resolvedRoot);
      const canonicalRoot = await realpath(resolvedRoot);
      const canonicalFile = await realpath(file);
      // A rule file is never read through a symlink that leaves the project.
      if (isWithinRoot(canonicalRoot, canonicalFile)) {
        const content = (await readFile(file, "utf8")).trim();
        if (content) {
          entries.push(
            limitInstruction(
              normalizeStablePath(relative(resolvedRoot, file)) || STICKY_RULE_FILE_NAME,
              content,
              options.maxProjectBytes ?? MAX_PROJECT_RULE_BYTES,
            ).entry,
          );
        }
      }
    } catch {
      // No project rule file, or an unreadable/broken link: nothing to add.
    }
  }

  return entries.length > 0 ? { entries } : undefined;
}

function normalizeStablePath(path: string): string {
  return path.replace(/\\/g, "/");
}

type LimitedInstruction = {
  entry: ProjectInstruction;
  /** UTF-8 bytes of file content kept, excluding any truncation notice. */
  bytes: number;
  truncated: boolean;
};

/**
 * Keep at most `maxBytes` of UTF-8 content without splitting a character.
 * A cut is never silent: the kept text is followed by a notice naming the
 * source and the kept/total byte counts, so the model can tell the file is
 * incomplete.
 */
function limitInstruction(
  source: string,
  content: string,
  maxBytes: number,
): LimitedInstruction {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= maxBytes) {
    return { entry: { source, content }, bytes: totalBytes, truncated: false };
  }
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  const notice = `[PI-Desktop truncated ${source}: loaded the first ${bytes} of ${totalBytes} bytes; the rest of this file is not in context.]`;
  const kept = content.slice(0, end).trimEnd();
  return {
    entry: { source, content: kept ? `${kept}\n\n${notice}` : notice },
    bytes,
    truncated: true,
  };
}

async function readInstruction(
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
  directory: string,
  remaining: number,
): Promise<LimitedInstruction | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    try {
      const file = join(directory, name);
      const canonicalFile = await realpath(file);
      if (!isWithinRoot(canonicalWorkspaceRoot, canonicalFile)) continue;
      const content = (await readFile(file, "utf8")).trim();
      if (!content) continue;
      return limitInstruction(
        normalizeStablePath(relative(workspaceRoot, file) || name),
        content,
        remaining,
      );
    } catch {
      // Try the next recognized name or the next directory.
    }
  }
  return undefined;
}

/**
 * Resolve project instructions from the workspace root to a workspace path.
 * Each directory contributes at most one file: AGENTS.override.md takes
 * precedence over AGENTS.md. The returned order gives nested files the last
 * word, matching Codex's project instruction chain.
 */
export async function loadProjectInstructions(
  workspaceRoot: string | null | undefined,
  workspacePath?: string,
  maxBytes = MAX_PROJECT_INSTRUCTION_BYTES,
): Promise<ProjectInstructions | undefined> {
  if (!workspaceRoot?.trim()) return undefined;

  const root = resolve(workspaceRoot);
  const canonicalRoot = await realpath(root).catch(() => root);
  const target = workspacePath?.trim()
    ? resolve(root, workspacePath)
    : root;
  // Instructions are never read from outside the project. A target outside the
  // root, or the root itself (whose parent lies outside), keeps the root's own
  // chain instead of dropping every project instruction.
  const targetDirectory =
    isWithinRoot(root, target) && target !== root ? dirname(target) : root;
  const directories: string[] = [];
  for (let current = targetDirectory; ; current = dirname(current)) {
    directories.unshift(current);
    if (current === root) break;
  }

  const entries: ProjectInstruction[] = [];
  let remaining = Math.max(0, maxBytes);
  for (const directory of directories) {
    if (remaining <= 0) break;
    const loaded = await readInstruction(root, canonicalRoot, directory, remaining);
    if (!loaded) continue;
    entries.push(loaded.entry);
    // A truncated file has used up the budget; closer files are not loaded.
    if (loaded.truncated) break;
    remaining -= loaded.bytes;
  }
  return entries.length > 0 ? { entries } : undefined;
}

/**
 * Build the complete chain: global defaults precede project instructions, and
 * sticky rules close the chain so their always-apply policy survives
 * compaction and wins conflicts against repository prose.
 * Each source family is capped independently.
 */
export async function loadInstructionChain(
  workspaceRoot: string | null | undefined,
  workspacePath?: string,
  globalPath?: string,
  globalRulesPath?: string,
): Promise<ProjectInstructions | undefined> {
  const resolvedGlobalPath = globalPath ?? globalInstructionPath();
  const entries: ProjectInstruction[] = [];
  try {
    const content = (await readFile(resolvedGlobalPath, "utf8")).trim();
    if (content) {
      entries.push(
        limitInstruction("~/.pi/agent/AGENTS.md", content, MAX_GLOBAL_INSTRUCTION_BYTES)
          .entry,
      );
    }
  } catch {
    // A missing global file is an expected first-run state.
  }
  const project = await loadProjectInstructions(workspaceRoot, workspacePath);
  // An overridden global instructions path implies its sibling rule file, so a
  // caller that points the chain at a test or profile directory stays isolated
  // from the machine's real PI_HOME.
  const resolvedGlobalRulesPath =
    globalRulesPath ?? (globalPath ? join(dirname(globalPath), STICKY_RULE_FILE_NAME) : undefined);
  const rules = await loadStickyRules(workspaceRoot, { globalPath: resolvedGlobalRulesPath });
  return entries.length || project?.entries.length || rules?.entries.length
    ? { entries: [...entries, ...(project?.entries ?? []), ...(rules?.entries ?? [])] }
    : undefined;
}
