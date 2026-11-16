/**
 * Agent long-term memory (ADR agent-long-term-memory): a local stdio MCP
 * server that gives sessions durable memory across projects and backends.
 *
 * The server lives in packages/agent-memory/server.mjs. The switch default is
 * off; off means nothing is registered and nothing is written — identical to
 * pre-feature behavior.
 *
 * Security posture (the same spawn shape as plugin-mcp.ts): launch command is
 * the current Electron executable, arguments are app-layout constants, shell
 * is disabled, and no user-, model-, or session-controlled text ever reaches
 * the command or its arguments. The memory root travels as an environment
 * variable, never as command text.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { getModuleDirectory } from "./module-path";

const MEMORY_ENTRY_NAME = "pi-desktop-agent-memory";

const spawnImpl: typeof nodeSpawn = nodeSpawn;

let activeServer: ChildProcess | null = null;

function memoryRootFor(): string {
  return join(app.getPath("userData"), "agent-memory");
}

function serverScriptFor(): string {
  // Packaged: extraResources; dev: repo layout two levels above main/.
  const packaged = join(process.resourcesPath ?? "", "agent-memory", "server.mjs");
  if (existsSync(packaged)) return packaged;
  return join(getModuleDirectory(import.meta.url), "..", "agent-memory", "server.mjs");
}

function serverEnv(memoryRoot: string): NodeJS.ProcessEnv {
  // No credential literals; the server is config-by-env only (ADR §2). The
  // memory root and empty cwd travel as env vars, never as command text.
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_MEMORY_DIR: memoryRoot,
    AGENT_MEMORY_CWD: "",
  };
}

/**
 * Spawn the memory server if enabled and not already running.
 */
export function ensureMemoryServer(enabled: boolean): void {
  if (!enabled) {
    stopMemoryServer();
    return;
  }
  if (activeServer && activeServer.exitCode === null && !activeServer.killed) {
    return;
  }
  const memoryRoot = memoryRootFor();
  mkdirSync(memoryRoot, { recursive: true });
  const script = serverScriptFor();
  if (!existsSync(script)) return;
  const child: ChildProcess = spawnImpl(process.execPath, [script], {
    env: serverEnv(memoryRoot),
    stdio: ["pipe", "pipe", "pipe"],
    // Arguments stay literal; this launch never needs a Windows shell shim
    // because both the command (Electron binary) and the argument (constant
    // script path) resolve without a shell.
    shell: false,
    windowsHide: true,
  });
  child.on("exit", () => {
    if (activeServer === child) activeServer = null;
  });
  activeServer = child;
}

export function stopMemoryServer(): void {
  if (activeServer && activeServer.exitCode === null && !activeServer.killed) {
    activeServer.kill();
  }
  activeServer = null;
}

/** The registration payload for the user's pi MCP config, when enabled. */
export function memoryRegistration(): {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} | null {
  const script = serverScriptFor();
  if (!existsSync(script)) return null;
  return {
    name: MEMORY_ENTRY_NAME,
    command: process.execPath,
    args: [script],
    env: serverEnv(memoryRootFor()),
  };
}

export const MEMORY_ENTRY = MEMORY_ENTRY_NAME;
