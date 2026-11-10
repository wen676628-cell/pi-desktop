/**
 * Read-only discovery of configuration other coding agents already keep on
 * disk. Nothing is migrated or rewritten: the point is to tell the user what
 * exists where, so PI-Desktop can offer it instead of asking for a re-setup.
 *
 * Modelled on oh-my-pi's discovery providers, scoped to what a desktop can
 * present today: instruction/rules files, skills and command directories, MCP
 * server files.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DiscoveredConfigProvider =
  | "agents-md"
  | "claude"
  | "cline"
  | "codex"
  | "copilot"
  | "cursor"
  | "gemini"
  | "opencode"
  | "windsurf";

export type DiscoveredConfigKind = "commands" | "instructions" | "mcp" | "rules" | "skills";

export type DiscoveredConfig = {
  provider: DiscoveredConfigProvider;
  kind: DiscoveredConfigKind;
  scope: "user" | "project";
  /** Absolute path that was inspected. */
  path: string;
  /** Files in a directory, servers in an MCP file; undefined for a plain file. */
  entries?: number;
};

export type DiscoverConfigOptions = {
  workspaceRoot?: string | null;
  /** Injectable for tests; defaults to the OS home directory. */
  home?: string;
  /** Stops a pathological tree from producing unbounded output. */
  maxEntries?: number;
};

const DEFAULT_MAX_ENTRIES = 200;

type Probe = {
  provider: DiscoveredConfigProvider;
  kind: DiscoveredConfigKind;
  scope: "user" | "project";
  /** A file name inside the base directory. */
  relative: string;
  /** A directory of files is counted rather than treated as one entry. */
  directory?: boolean;
};

/** Sources that live in the workspace. */
const PROJECT_PROBES: readonly Probe[] = [
  { provider: "agents-md", kind: "instructions", scope: "project", relative: "AGENTS.md" },
  { provider: "claude", kind: "instructions", scope: "project", relative: "CLAUDE.md" },
  { provider: "claude", kind: "skills", scope: "project", relative: ".claude/skills", directory: true },
  { provider: "claude", kind: "commands", scope: "project", relative: ".claude/commands", directory: true },
  { provider: "cursor", kind: "rules", scope: "project", relative: ".cursor/rules", directory: true },
  { provider: "cursor", kind: "rules", scope: "project", relative: ".cursorrules" },
  { provider: "cline", kind: "rules", scope: "project", relative: ".clinerules" },
  { provider: "cline", kind: "rules", scope: "project", relative: ".clinerules", directory: true },
  { provider: "windsurf", kind: "rules", scope: "project", relative: ".windsurfrules" },
  {
    provider: "copilot",
    kind: "instructions",
    scope: "project",
    relative: ".github/copilot-instructions.md",
  },
  { provider: "codex", kind: "instructions", scope: "project", relative: "AGENTS.md" },
  { provider: "gemini", kind: "instructions", scope: "project", relative: "GEMINI.md" },
  { provider: "opencode", kind: "instructions", scope: "project", relative: "AGENTS.md" },
  { provider: "agents-md", kind: "mcp", scope: "project", relative: ".mcp.json" },
];

/** Sources that live in the user's home directory. */
const USER_PROBES: readonly Probe[] = [
  { provider: "claude", kind: "instructions", scope: "user", relative: ".claude/CLAUDE.md" },
  { provider: "claude", kind: "skills", scope: "user", relative: ".claude/skills", directory: true },
  { provider: "claude", kind: "commands", scope: "user", relative: ".claude/commands", directory: true },
  { provider: "codex", kind: "instructions", scope: "user", relative: ".codex/AGENTS.md" },
  { provider: "gemini", kind: "instructions", scope: "user", relative: ".gemini/GEMINI.md" },
  { provider: "cursor", kind: "rules", scope: "user", relative: ".cursor/rules", directory: true },
  { provider: "opencode", kind: "instructions", scope: "user", relative: ".config/opencode/AGENTS.md" },
];

async function countChildren(path: string): Promise<number | undefined> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() || entry.isDirectory()).length;
  } catch {
    return undefined;
  }
}

async function countMcpServers(path: string): Promise<number | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers as object).length : 0;
  } catch {
    return undefined;
  }
}

async function probe(base: string, entry: Probe): Promise<DiscoveredConfig | undefined> {
  const path = join(base, entry.relative);
  try {
    const info = await stat(path);
    if (entry.directory) {
      if (!info.isDirectory()) return undefined;
      return {
        provider: entry.provider,
        kind: entry.kind,
        scope: entry.scope,
        path,
        entries: await countChildren(path),
      };
    }
    if (!info.isFile()) return undefined;
    if (entry.kind === "mcp") {
      return {
        provider: entry.provider,
        kind: entry.kind,
        scope: entry.scope,
        path,
        entries: await countMcpServers(path),
      };
    }
    return { provider: entry.provider, kind: entry.kind, scope: entry.scope, path };
  } catch {
    return undefined;
  }
}

/**
 * Inspect the workspace and the user's home for configuration written by other
 * coding agents. Presence is reported even when PI-Desktop already reads the
 * same file elsewhere (AGENTS.md is both a shared convention and a PI-Desktop
 * instruction source), because the settings surface explains the overlap.
 */
export async function discoverExternalConfig(
  options: DiscoverConfigOptions = {},
): Promise<DiscoveredConfig[]> {
  const found: DiscoveredConfig[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);

  const workspace = options.workspaceRoot?.trim();
  if (workspace) {
    const base = resolve(workspace);
    for (const entry of PROJECT_PROBES) {
      const hit = await probe(base, entry);
      if (!hit || seen.has(hit.path)) continue;
      seen.add(hit.path);
      found.push(hit);
      if (found.length >= limit) return found;
    }
  }

  const home = options.home ?? homedir();
  for (const entry of USER_PROBES) {
    const hit = await probe(resolve(home), entry);
    if (!hit || seen.has(hit.path)) continue;
    seen.add(hit.path);
    found.push(hit);
    if (found.length >= limit) return found;
  }

  return found;
}
