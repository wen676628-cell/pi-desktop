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
import { syncPiMemoryRegistration, type MemoryMcpLaunch } from "./agent-memory-registration";
import { getModuleDirectory } from "./module-path";

const MEMORY_ENTRY_NAME = "pi-desktop-agent-memory";

/** Host data file that owns the transcript index the server reads. */
const HOST_DB_FILE = "pi.sqlite";

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

function serverEnv(memoryRoot: string, dataDir: string): NodeJS.ProcessEnv {
  // No credential literals; the server is config-by-env only (ADR §2). The
  // memory root, the session cwd and the host transcript index travel as env
  // vars, never as command text.
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_MEMORY_DIR: memoryRoot,
    AGENT_MEMORY_CWD: "",
    // The host owns the transcript index; the server reads it read-only and
    // never takes a second copy of session history.
    AGENT_MEMORY_SOURCES: JSON.stringify([
      { backend: "pi", db: join(dataDir, HOST_DB_FILE) },
    ]),
  };
}

/**
 * Apply the stored switch: run the server while it is on and keep pi's MCP
 * config pointing at it. Both halves are idempotent, so boot and every
 * settings write can call this.
 *
 * `dataDir` is the host data root, where the transcript index lives.
 */
export function applyAgentMemory(enabled: boolean, dataDir: string): void {
  ensureMemoryServer(enabled, dataDir);
  const launch = enabled ? memoryRegistration(dataDir) : null;
  const result = syncPiMemoryRegistration(enabled, launch);
  if (result === "failed" || result === "skipped-malformed") {
    console.warn(`agent-memory: pi MCP registration ${result}`);
  }
}

/** Spawn the memory server if enabled and not already running. */
function ensureMemoryServer(enabled: boolean, dataDir: string): void {
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
    env: serverEnv(memoryRoot, dataDir),
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

/** The launch payload pi's MCP config needs, when the server script exists. */
export function memoryRegistration(dataDir: string): MemoryMcpLaunch | null {
  const script = serverScriptFor();
  if (!existsSync(script)) return null;
  return {
    command: process.execPath,
    args: [script],
    env: serverEnv(memoryRootFor(), dataDir),
  };
}

export const MEMORY_ENTRY = MEMORY_ENTRY_NAME;
