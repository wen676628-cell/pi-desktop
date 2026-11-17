/**
 * Agent long-term memory surfaces shared by the settings IPC and the renderer
 * (ADR agent-long-term-memory, rollout 4). The Markdown files remain the truth;
 * these are the shapes the panel reads.
 */

export type AgentMemoryScopeTarget =
  | "memory"
  | "user"
  | "standing"
  | "failure"
  | "project"
  | "project-failure";

export type AgentMemoryScopeUsage = {
  id: string;
  target: AgentMemoryScopeTarget;
  projectId?: string;
  entries: number;
  chars: number;
  maxEntries: number;
  maxChars: number;
  overBudget: boolean;
};

export type AgentMemoryStatus = {
  scopes: AgentMemoryScopeUsage[];
  totalEntries: number;
  projects: string[];
};

export type AgentMemoryImportResult = {
  added: number;
  duplicates: number;
  tombstoned: number;
  trimmed: number;
};

/** Exported package shape; device-local memory is never part of it. */
export type AgentMemoryPackage = {
  kind: "pi-desktop-agent-memory";
  version: number;
  exportedAt: string;
  scopes: Record<string, string[]>;
  projects: Record<string, { memory: string[]; failures: string[] }>;
  tombstones: string[];
};
