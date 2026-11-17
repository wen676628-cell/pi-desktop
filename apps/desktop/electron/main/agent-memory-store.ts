/**
 * Memory store read/write surface for the settings panel
 * (ADR agent-long-term-memory, rollout 4).
 *
 * The Markdown files stay the truth; this module only lists them, exports
 * them, and merges them back. Everything here is pure filesystem work over an
 * explicit `memoryDir`, so the settings IPC and the tests share one code path.
 *
 * Device-local memory is deliberately excluded from export: the ADR keeps
 * drive letters and machine paths off other machines by construction.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AgentMemoryImportResult,
  AgentMemoryPackage,
  AgentMemoryScopeUsage,
  AgentMemoryStatus,
} from "@pi-desktop/shared";

export type MemoryImportResult = AgentMemoryImportResult;
export type MemoryPackage = AgentMemoryPackage;
export type MemoryScopeUsage = AgentMemoryScopeUsage;
export type MemoryStatus = AgentMemoryStatus;

export const MEMORY_PACKAGE_KIND = "pi-desktop-agent-memory";
export const MEMORY_PACKAGE_VERSION = 1;

const ENTRY_SEPARATOR = "\n§\n";
const MAX_ENTRY_CHARS = 2000;

const SCOPES = {
  memory: { file: "MEMORY.md", label: "memory", chars: 32000, entries: 400 },
  user: { file: "USER.md", label: "user", chars: 32000, entries: 400 },
  standing: { file: "STANDING.md", label: "standing", chars: 4000, entries: 40 },
  failure: { file: "failures.md", label: "failure", chars: 32000, entries: 400 },
};
const PROJECT_MEMORY = { chars: 32000, entries: 400 };
const PROJECT_FAILURES = { chars: 4000, entries: 40 };


const parseEntries = (text: string): string[] =>
  text
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.replace(/^\s*\n/, "").replace(/\n\s*$/, ""))
    .filter((entry) => entry.trim().length > 0);

const serializeEntries = (entries: string[]): string =>
  entries.length === 0 ? "" : entries.join(ENTRY_SEPARATOR) + "\n";

const readEntries = (file: string): string[] => {
  try {
    return existsSync(file) ? parseEntries(readFileSync(file, "utf8")) : [];
  } catch {
    return [];
  }
};

const atomicWrite = (file: string, content: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
};

const usage = (
  id: string,
  target: MemoryScopeUsage["target"],
  entries: string[],
  budget: { chars: number; entries: number },
  projectId?: string,
): MemoryScopeUsage => {
  const chars = entries.reduce((sum, entry) => sum + entry.length, 0);
  return {
    id,
    target,
    ...(projectId ? { projectId } : {}),
    entries: entries.length,
    chars,
    maxEntries: budget.entries,
    maxChars: budget.chars,
    overBudget: entries.length > budget.entries || chars > budget.chars,
  };
};

/** Project directories that currently hold memory files. */
export function listProjectKeys(memoryDir: string): string[] {
  try {
    const root = join(memoryDir, "projects");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Usage for every scope the panel shows; the device scope is not listed. */
export function readMemoryStatus(memoryDir: string): MemoryStatus {
  const scopes: MemoryScopeUsage[] = [];
  for (const [key, budget] of Object.entries(SCOPES)) {
    const entries = readEntries(join(memoryDir, budget.file));
    scopes.push(usage(key, key as MemoryScopeUsage["target"], entries, budget));
  }
  const projects = listProjectKeys(memoryDir);
  for (const projectId of projects) {
    const dir = join(memoryDir, "projects", projectId);
    scopes.push(
      usage(`${projectId}:memory`, "project", readEntries(join(dir, "MEMORY.md")), PROJECT_MEMORY, projectId),
    );
    scopes.push(
      usage(`${projectId}:failure`, "project-failure", readEntries(join(dir, "failures.md")), PROJECT_FAILURES, projectId),
    );
  }
  return {
    scopes,
    totalEntries: scopes.reduce((sum, scope) => sum + scope.entries, 0),
    projects,
  };
}

const readTombstones = (memoryDir: string): string[] => {
  try {
    const parsed = JSON.parse(readFileSync(join(memoryDir, "tombstones.json"), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Export the hand-editable entries as a plain JSON package.
 * Device-local memory never leaves the machine (ADR §2).
 */
export function exportMemoryPackage(memoryDir: string, now = new Date()): MemoryPackage {
  const scopes: Record<string, string[]> = {};
  for (const [key, budget] of Object.entries(SCOPES)) {
    scopes[key] = readEntries(join(memoryDir, budget.file));
  }
  const projects: MemoryPackage["projects"] = {};
  for (const projectId of listProjectKeys(memoryDir)) {
    const dir = join(memoryDir, "projects", projectId);
    projects[projectId] = {
      memory: readEntries(join(dir, "MEMORY.md")),
      failures: readEntries(join(dir, "failures.md")),
    };
  }
  return {
    kind: MEMORY_PACKAGE_KIND,
    version: MEMORY_PACKAGE_VERSION,
    exportedAt: now.toISOString(),
    scopes,
    projects,
    tombstones: readTombstones(memoryDir),
  };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Structural validation: a package from elsewhere is untrusted input. */
export function validateMemoryPackage(value: unknown): value is MemoryPackage {
  if (typeof value !== "object" || value === null) return false;
  const pkg = value as Partial<MemoryPackage>;
  if (pkg.kind !== MEMORY_PACKAGE_KIND) return false;
  if (typeof pkg.version !== "number" || pkg.version > MEMORY_PACKAGE_VERSION) return false;
  if (typeof pkg.scopes !== "object" || pkg.scopes === null) return false;
  if (!Object.values(pkg.scopes).every(isStringArray)) return false;
  if (typeof pkg.projects !== "object" || pkg.projects === null) return false;
  for (const project of Object.values(pkg.projects)) {
    if (typeof project !== "object" || project === null) return false;
    if (!isStringArray(project.memory) || !isStringArray(project.failures)) return false;
  }
  if (pkg.tombstones !== undefined && !isStringArray(pkg.tombstones)) return false;
  return true;
}

const normalize = (entry: string): string => entry.replace(/\s+/g, " ").trim();

type MergeTally = { added: number; duplicates: number; tombstoned: number; trimmed: number };

function mergeInto(
  file: string,
  incoming: string[],
  budget: { chars: number; entries: number },
  tombstones: Set<string>,
  tally: MergeTally,
): void {
  const existing = readEntries(file);
  const seen = new Set(existing.map(normalize));
  let changed = false;
  for (const raw of incoming) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    // Imported entries are capped like hand-written ones; an oversized entry
    // would otherwise make the next local write trim the file by surprise.
    const capped = entry.slice(0, MAX_ENTRY_CHARS);
    const key = normalize(capped);
    if (tombstones.has(`${file}:${key}`)) {
      tally.tombstoned += 1;
      continue;
    }
    if (seen.has(key)) {
      tally.duplicates += 1;
      continue;
    }
    seen.add(key);
    existing.push(capped);
    tally.added += 1;
    changed = true;
  }
  if (!changed) return;
  // Oldest-first trim, identical to the server's rule.
  let chars = existing.reduce((sum, entry) => sum + entry.length, 0);
  while (existing.length > budget.entries || chars > budget.chars) {
    const dropped = existing.shift();
    if (dropped === undefined) break;
    chars -= dropped.length;
    tally.trimmed += 1;
  }
  atomicWrite(file, serializeEntries(existing));
}

/**
 * Merge a package into this machine's memory.
 *
 * Tombstones win over imported entries, duplicates are counted not added, and
 * budgets trim oldest-first exactly like a local write.
 */
export function importMemoryPackage(memoryDir: string, pkg: MemoryPackage): MemoryImportResult {
  const tally: MergeTally = { added: 0, duplicates: 0, tombstoned: 0, trimmed: 0 };
  const tombstones = new Set([...readTombstones(memoryDir), ...(pkg.tombstones ?? [])]);

  for (const [key, budget] of Object.entries(SCOPES)) {
    const incoming = pkg.scopes[key];
    if (!incoming?.length) continue;
    mergeInto(join(memoryDir, budget.file), incoming, budget, tombstones, tally);
  }

  for (const [projectId, files] of Object.entries(pkg.projects)) {
    // A project key is a directory name; reject anything that could escape it.
    if (!projectId || basename(projectId) !== projectId || projectId.includes("..")) continue;
    const dir = join(memoryDir, "projects", projectId);
    if (files.memory?.length) {
      mergeInto(join(dir, "MEMORY.md"), files.memory, PROJECT_MEMORY, tombstones, tally);
    }
    if (files.failures?.length) {
      mergeInto(join(dir, "failures.md"), files.failures, PROJECT_FAILURES, tombstones, tally);
    }
  }

  if (tombstones.size > 0) {
    atomicWrite(join(memoryDir, "tombstones.json"), `${JSON.stringify([...tombstones].slice(-1000), null, 2)}\n`);
  }
  return tally;
}
