/**
 * pi MCP registration for agent memory (ADR agent-long-term-memory §5).
 *
 * The memory server reaches a session only if pi knows about it, so enabling
 * the switch writes exactly one entry into pi's own MCP config. Two rules keep
 * this safe next to a user-maintained file:
 *
 *   - only the fork's entry is ever added, changed, or removed;
 *   - a file whose `mcpServers` is not an object is left alone entirely —
 *     "skip and never repair-overwrite" (ADR §5), because a malformed file is
 *     the user's to fix, not ours to rewrite.
 *
 * Writes are atomic (temp file + rename in the same directory).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MEMORY_MCP_ENTRY = "pi-desktop-agent-memory";

export type MemoryMcpLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type RegistrationResult =
  | "written"
  | "unchanged"
  | "removed"
  | "absent"
  | "skipped-malformed"
  | "failed";

export function piMcpConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "mcp.json");
}

function readConfig(file: string): Record<string, unknown> | null | "malformed" {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "malformed";
    }
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
      return "malformed";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "malformed";
  }
}

function writeAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

/**
 * Add or refresh the fork's entry, or remove just that entry when disabled.
 * Every other key in the file is preserved byte-for-byte at the JSON level.
 */
export function syncPiMemoryRegistration(
  enabled: boolean,
  launch: MemoryMcpLaunch | null,
  file = piMcpConfigPath(),
): RegistrationResult {
  try {
    const config = readConfig(file);
    if (config === "malformed") return "skipped-malformed";

    const servers = {
      ...((config?.mcpServers as Record<string, unknown> | undefined) ?? {}),
    };
    const current = servers[MEMORY_MCP_ENTRY];

    if (!enabled) {
      if (current === undefined) return "absent";
      delete servers[MEMORY_MCP_ENTRY];
      const next: Record<string, unknown> = { ...(config ?? {}) };
      // Leave no empty container behind when ours was the only entry.
      if (Object.keys(servers).length === 0) delete next.mcpServers;
      else next.mcpServers = servers;
      writeAtomic(file, next);
      return "removed";
    }

    // A launch payload that cannot be built means the script is missing; a
    // dangling entry would be worse than none.
    if (!launch) return "absent";
    const entry = { command: launch.command, args: launch.args, env: launch.env };
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(entry)) {
      return "unchanged";
    }
    servers[MEMORY_MCP_ENTRY] = entry;
    writeAtomic(file, { ...(config ?? {}), mcpServers: servers });
    return "written";
  } catch {
    // A registration failure must not take the app down; the next settings
    // write or the next boot retries.
    return "failed";
  }
}
