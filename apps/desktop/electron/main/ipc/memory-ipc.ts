/**
 * Agent memory settings channels (ADR agent-long-term-memory, rollout 4).
 *
 * Status, export, and import over the memory Markdown files. Export/import go
 * through native dialogs so the renderer never handles a filesystem path.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import {
  exportMemoryPackage,
  importMemoryPackage,
  readMemoryStatus,
  validateMemoryPackage,
  type MemoryImportResult,
  type MemoryPackage,
} from "../agent-memory-store";

export type AgentMemoryIpcDependencies = {
  registrar: IpcRegistrar;
  /** Memory root: the same directory the server writes. */
  memoryDir?: () => string;
};

const defaultMemoryDir = (): string => join(app.getPath("userData"), "agent-memory");

export function registerAgentMemoryIpc({
  registrar,
  memoryDir = defaultMemoryDir,
}: AgentMemoryIpcDependencies): void {
  registrar.handle(IPC.invoke.agentMemoryStatus, async () => readMemoryStatus(memoryDir()));

  registrar.handle(IPC.invoke.agentMemoryExport, async () => {
    const pkg = exportMemoryPackage(memoryDir());
    const result = await dialog.showSaveDialog({
      title: "Export agent memory",
      defaultPath: join(app.getPath("documents"), "pi-desktop-memory.json"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { saved: false, entries: 0 };
    writeFileSync(result.filePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    const entries = Object.values(pkg.scopes).reduce((sum, list) => sum + list.length, 0);
    return { saved: true, entries };
  });

  registrar.handle(IPC.invoke.agentMemoryImport, async (): Promise<
    { imported: false } | { imported: true; result: MemoryImportResult }
  > => {
    const picked = await dialog.showOpenDialog({
      title: "Import agent memory",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const file = picked.filePaths?.[0];
    if (picked.canceled || !file) return { imported: false };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    // A package from elsewhere is untrusted input: shape first, then merge.
    if (!validateMemoryPackage(parsed)) {
      throw Object.assign(new Error("not a PI-Desktop memory package"), {
        errorCode: "INVALID_PARAMS",
      });
    }
    const result = importMemoryPackage(memoryDir(), parsed as MemoryPackage);
    return { imported: true, result };
  });
}
