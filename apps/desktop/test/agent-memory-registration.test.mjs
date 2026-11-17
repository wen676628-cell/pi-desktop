/**
 * pi MCP registration for agent memory (ADR agent-long-term-memory §5).
 *
 * The rules under test are the ones that protect a user-maintained config
 * file: only the fork's entry is touched, a malformed file is never rewritten,
 * and disabling removes the entry without leaving an empty container.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MEMORY_MCP_ENTRY,
  piMcpConfigPath,
  syncPiMemoryRegistration,
} from "../electron/main/agent-memory-registration.ts";

const launch = {
  command: "/opt/pi-desktop/electron",
  args: ["/opt/pi-desktop/agent-memory/server.mjs"],
  env: { AGENT_MEMORY_DIR: "/home/u/.pi-desktop/agent-memory" },
};

async function withConfig(initial, run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
  const file = join(dir, "mcp.json");
  if (initial !== undefined) {
    await writeFile(
      file,
      typeof initial === "string" ? initial : JSON.stringify(initial, null, 2),
      "utf8",
    );
  }
  try {
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("the config path is pi's own agent config directory", () => {
  assert.equal(piMcpConfigPath("/home/u"), join("/home/u", ".pi", "agent", "mcp.json"));
});

test("enabling writes exactly one entry and preserves the user's servers", async () => {
  await withConfig(
    { mcpServers: { "user-server": { command: "uvx", args: ["thing"] } }, theme: "dark" },
    async (file) => {
      const result = syncPiMemoryRegistration(true, launch, file);
      assert.equal(result, "written");
      const config = await readJson(file);
      assert.deepEqual(config.mcpServers["user-server"], { command: "uvx", args: ["thing"] });
      assert.deepEqual(config.mcpServers[MEMORY_MCP_ENTRY], launch);
      assert.equal(config.theme, "dark", "unrelated keys survive");
    },
  );
});

test("enabling creates the file and directory when pi has none yet", async () => {
  await withConfig(undefined, async (file) => {
    assert.equal(existsSync(file), false);
    assert.equal(syncPiMemoryRegistration(true, launch, file), "written");
    const config = await readJson(file);
    assert.deepEqual(config.mcpServers, { [MEMORY_MCP_ENTRY]: launch });
  });
});

test("re-applying an identical payload reports unchanged and rewrites nothing", async () => {
  await withConfig(undefined, async (file) => {
    syncPiMemoryRegistration(true, launch, file);
    const before = await readFile(file, "utf8");
    assert.equal(syncPiMemoryRegistration(true, launch, file), "unchanged");
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("a changed payload refreshes the entry in place", async () => {
  await withConfig(undefined, async (file) => {
    syncPiMemoryRegistration(true, launch, file);
    const moved = { ...launch, args: ["/new/location/server.mjs"] };
    assert.equal(syncPiMemoryRegistration(true, moved, file), "written");
    const config = await readJson(file);
    assert.deepEqual(config.mcpServers[MEMORY_MCP_ENTRY].args, ["/new/location/server.mjs"]);
  });
});

test("disabling removes only the fork's entry and drops an emptied container", async () => {
  await withConfig(undefined, async (file) => {
    syncPiMemoryRegistration(true, launch, file);
    assert.equal(syncPiMemoryRegistration(false, null, file), "removed");
    const config = await readJson(file);
    assert.equal("mcpServers" in config, false, "no empty mcpServers left behind");
  });

  await withConfig(
    { mcpServers: { "user-server": { command: "uvx" } } },
    async (file) => {
      syncPiMemoryRegistration(true, launch, file);
      assert.equal(syncPiMemoryRegistration(false, null, file), "removed");
      const config = await readJson(file);
      assert.deepEqual(config.mcpServers, { "user-server": { command: "uvx" } });
    },
  );
});

test("disabling when nothing was registered is a no-op", async () => {
  await withConfig({ mcpServers: { "user-server": { command: "uvx" } } }, async (file) => {
    const before = await readFile(file, "utf8");
    assert.equal(syncPiMemoryRegistration(false, null, file), "absent");
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("a malformed file is never rewritten", async () => {
  // Not JSON at all.
  await withConfig("{ this is not json", async (file) => {
    const before = await readFile(file, "utf8");
    assert.equal(syncPiMemoryRegistration(true, launch, file), "skipped-malformed");
    assert.equal(await readFile(file, "utf8"), before);
  });

  // `mcpServers` present but the wrong shape: the user fixes it, not us.
  await withConfig({ mcpServers: ["oops"] }, async (file) => {
    const before = await readFile(file, "utf8");
    assert.equal(syncPiMemoryRegistration(true, launch, file), "skipped-malformed");
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("a missing launch payload never writes a dangling entry", async () => {
  await withConfig(undefined, async (file) => {
    assert.equal(syncPiMemoryRegistration(true, null, file), "absent");
    assert.equal(existsSync(file), false);
  });
});
