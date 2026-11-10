import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverExternalConfig } from "./discover-config.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("discoverExternalConfig", () => {
  it("reports project sources that exist and skips the rest", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-discovery-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use pnpm.");
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(join(root, ".cursor", "rules", "style.mdc"), "Prefer small files.");
    await writeFile(join(root, ".windsurfrules"), "Keep diffs tight.");

    const found = await discoverExternalConfig({ workspaceRoot: root, home });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "agents-md", kind: "instructions", scope: "project" }),
        expect.objectContaining({
          provider: "cursor",
          kind: "rules",
          scope: "project",
          path: join(root, ".cursor", "rules"),
          entries: 1,
        }),
        expect.objectContaining({
          provider: "windsurf",
          kind: "rules",
          path: join(root, ".windsurfrules"),
        }),
      ]),
    );
    expect(found.some((entry) => entry.provider === "cline")).toBe(false);
  });

  it("counts MCP servers in a project .mcp.json", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-discovery-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { files: {}, search: {} } }),
    );

    const found = await discoverExternalConfig({ workspaceRoot: root, home });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "agents-md",
          kind: "mcp",
          path: join(root, ".mcp.json"),
          entries: 2,
        }),
      ]),
    );
  });

  it("reads user-level sources from the injected home", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-discovery-"));
    const home = join(root, "home");
    await mkdir(join(home, ".claude", "skills", "review"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "User conventions.");

    const found = await discoverExternalConfig({ workspaceRoot: null, home });

    expect(found).toEqual([
      expect.objectContaining({
        provider: "claude",
        kind: "instructions",
        scope: "user",
        path: join(home, ".claude", "CLAUDE.md"),
      }),
      expect.objectContaining({
        provider: "claude",
        kind: "skills",
        scope: "user",
        entries: 1,
      }),
    ]);
  });

  it("deduplicates a path shared by several conventions", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-discovery-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Shared convention.");

    const found = await discoverExternalConfig({ workspaceRoot: root, home });
    const agents = found.filter((entry) => entry.path === join(root, "AGENTS.md"));

    expect(agents).toHaveLength(1);
  });

  it("caps the report at maxEntries", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-discovery-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use pnpm.");
    await writeFile(join(root, ".windsurfrules"), "Keep diffs tight.");

    await expect(
      discoverExternalConfig({ workspaceRoot: root, home, maxEntries: 1 }),
    ).resolves.toHaveLength(1);
  });
});
