/**
 * Tests for the agent long-term memory server's core storage semantics
 * (ADR agent-long-term-memory): parsing, budgets, tombstones, dedupe,
 * project-key derivation, and the tool surface. The MCP protocol layer is
 * exercised separately by spawning the server.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const serverPath = join(repoRoot, "packages/agent-memory/server.mjs");
const serverPathPlain = serverPath;

async function makeProfile() {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-memory-"));
  return { dir, env: { AGENT_MEMORY_DIR: dir, AGENT_MEMORY_CWD: "D:/work/demo" } };
}

async function callTool(env, name, args) {
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const result = spawnSync(
    process.execPath,
    [serverPathPlain],
    {
      encoding: "utf8",
      input: JSON.stringify(message) + "\n",
      env: { ...process.env, ...env },
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, `server exit: ${result.stderr}`);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const response = JSON.parse(lines.at(-1));
  assert.equal(response.id, 1);
  const payload = JSON.parse(response.result.content[0].text);
  return { payload, raw: response };
}

async function listTools(env) {
  const message = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const result = spawnSync(
    process.execPath,
    [serverPathPlain],
    { encoding: "utf8", input: JSON.stringify(message) + "\n", env: { ...process.env, ...env }, timeout: 15000 },
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1)).tools;
}

test("server refuses to start without an explicit memory dir", () => {
  const result = spawnSync(process.execPath, [serverPathPlain], {
    encoding: "utf8",
    env: { ...process.env, AGENT_MEMORY_DIR: "" },
    timeout: 10000,
  });
  assert.notEqual(result.status, 0, "no-dir startup must fail");
  assert.match(result.stderr, /AGENT_MEMORY_DIR is required/);
});

test("memory_add then memory_get round-trips an entry", async () => {
  const { dir, env } = await makeProfile();
  const add = await callTool(env, "memory_add", { target: "memory", entry: "User prefers pnpm." });
  assert.equal(add.payload.added, true);
  const get = await callTool(env, "memory_get", { target: "memory" });
  assert.deepEqual(get.payload.entries, ["User prefers pnpm."]);
  await rm(dir, { recursive: true, force: true });
});

test("whitespace-folding dedupe never creates a second entry", async () => {
  const { dir, env } = await makeProfile();
  await callTool(env, "memory_add", { target: "memory", entry: "Use pnpm  \n  workspaces." });
  const again = await callTool(env, "memory_add", {
    target: "memory",
    entry: "Use pnpm workspaces.",
  });
  assert.equal(again.payload.added, false);
  assert.equal(again.payload.reason, "duplicate");
  const get = await callTool(env, "memory_get", { target: "memory" });
  assert.equal(get.payload.entries.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("project memory keys derive a hash suffix and never collide", async () => {
  const { dir, env } = await makeProfile();
  const a = await callTool(env, "memory_add", {
    target: "project",
    projectId: "demo-a-11111111",
    entry: "Project A convention: tabs.",
  });
  assert.equal(a.payload.added, true);
  const file = join(dir, "projects", "demo-a-11111111", "MEMORY.md");
  const content = await readFile(file, "utf8");
  assert.match(content, /tabs\./);
  await rm(dir, { recursive: true, force: true });
});

test("failure entries require a category and carry the [category] prefix", async () => {
  const { dir, env } = await makeProfile();
  const noCategory = await callTool(env, "memory_add", {
    target: "failure",
    entry: "broke the build",
  });
  assert.equal(noCategory.payload.ok, false);
  const add = await callTool(env, "memory_add", {
    target: "failure",
    category: "build",
    entry: "broke the build with a stale lockfile",
  });
  assert.equal(add.payload.added, true);
  const get = await callTool(env, "memory_get", { target: "failure" });
  assert.match(get.payload.entries[0], /^\[build\] /);
  await rm(dir, { recursive: true, force: true });
});

test("memory_remove tombstones so a re-add of the same text can revive deliberately", async () => {
  const { dir, env } = await makeProfile();
  await callTool(env, "memory_add", { target: "memory", entry: "Stale fact." });
  const remove = await callTool(env, "memory_remove", { target: "memory", match: "Stale fact." });
  assert.equal(remove.payload.removed, 1);
  const get = await callTool(env, "memory_get", { target: "memory" });
  assert.deepEqual(get.payload.entries, []);
  const tombstones = JSON.parse(
    await readFile(join(dir, "tombstones.json"), "utf8"),
  );
  assert.equal(tombstones.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("budget trim drops oldest first and reports the count", async () => {
  const { dir, env } = await makeProfile();
  // BUDGETS.memory.entries = 400; add 402 and expect 2 dropped.
  for (let i = 0; i < 402; i += 1) {
    await callTool(env, "memory_add", { target: "memory", entry: `fact ${i}` });
  }
  const get = await callTool(env, "memory_get", { target: "memory" });
  assert.equal(get.payload.total, 400);
  const content = await readFile(join(dir, "MEMORY.md"), "utf8");
  // Oldest-first trim: fact 0/1 are gone, fact 2 is the oldest survivor.
  assert.doesNotMatch(content, /fact 0\b/, "oldest entries trimmed first");
  assert.match(content, /fact 2\b/, "oldest surviving entry is fact 2");
  await rm(dir, { recursive: true, force: true });
});

test("memory_search returns elsewhere hits with a hint", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-memory-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-memory-b-"));
  // Scope A (current cwd D:/work/demo) gets a hit; scope B gets the needle.
  await callTool(
    { AGENT_MEMORY_DIR: dirA, AGENT_MEMORY_CWD: "D:/work/demo" },
    "memory_add",
    { target: "memory", entry: "Current project fact." },
  );
  await callTool(
    { AGENT_MEMORY_DIR: dirB, AGENT_MEMORY_CWD: "D:/work/other" },
    "memory_add",
    { target: "memory", entry: "Needle stored in the other project." },
  );
  // A server pointed at dirA with a collection source covering dirB must
  // surface the other project's hit via `elsewhere`, not leave it invisible.
  const result = spawnSync(
    process.execPath,
    [serverPathPlain],
    {
      encoding: "utf8",
      input:
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "needle", scope: "all" } } }) + "\n",
      env: {
        ...process.env,
        AGENT_MEMORY_DIR: dirA,
        AGENT_MEMORY_CWD: "D:/work/demo",
        AGENT_MEMORY_SOURCES: JSON.stringify([
          { backend: "pi", dir: dirA, project: "demo" },
          { backend: "pi", dir: dirB, project: "other" },
        ]),
      },
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1));
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.ok, true);
  const elsewhereHit = payload.elsewhere?.find((hit) => hit.projectId.startsWith("other"));
  assert.ok(elsewhereHit, "the other project's needle is reported via elsewhere");
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

test("session_search reports session-sources-empty when no sources configured", async () => {
  const { dir, env } = await makeProfile();
  const result = await callTool(env, "session_search", { query: "anything" });
  assert.equal(result.payload.error?.code, "session-sources-empty");
  await rm(dir, { recursive: true, force: true });
});

/** A host-shaped transcript index: sessions + messages + FTS5 over the text. */
async function makeHostIndex(rows) {
  const dir = await mkdtemp(join(tmpdir(), "pi-host-index-"));
  const file = join(dir, "pi.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE messages (
      mid INTEGER PRIMARY KEY, id TEXT, session_id TEXT, role TEXT,
      text TEXT, created_at INTEGER
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, content='messages', content_rowid='mid', tokenize='trigram'
    );
  `);
  for (const row of rows) {
    db.prepare("INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)").run(
      row.sessionId,
      row.title ?? "",
    );
    db.prepare(
      "INSERT INTO messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(`${row.sessionId}-${row.createdAt}`, row.sessionId, row.role, row.text, row.createdAt);
  }
  db.exec("INSERT INTO messages_fts (rowid, text) SELECT mid, text FROM messages");
  db.close();
  return { dir, file };
}

test("session_search reads the host transcript index read-only", async () => {
  const { dir: memoryDir, env } = await makeProfile();
  const index = await makeHostIndex([
    { sessionId: "s1", title: "Fix the flaky test", role: "user", text: "the workspace index test is flaky again", createdAt: 100 },
    { sessionId: "s1", title: "Fix the flaky test", role: "assistant", text: "raised the spin budget to two hundred turns", createdAt: 101 },
    { sessionId: "s2", title: "Unrelated", role: "user", text: "unrelated conversation about icons", createdAt: 102 },
  ]);
  const result = await callTool(
    { ...env, AGENT_MEMORY_SOURCES: JSON.stringify([{ backend: "pi", db: index.file }]) },
    "session_search",
    { query: "flaky" },
  );
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.hits.length, 1, "only the matching session is returned");
  const hit = result.payload.hits[0];
  assert.equal(hit.sessionId, "s1");
  assert.equal(hit.title, "Fix the flaky test");
  assert.equal(hit.backend, "pi");
  assert.ok(hit.matches.length >= 1);
  assert.match(hit.matches.map((match) => match.snippet).join(" "), /\[flaky\]/);
  // The server never writes to a host index.
  const { DatabaseSync } = await import("node:sqlite");
  const check = new DatabaseSync(index.file, { readOnly: true });
  const count = check.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  check.close();
  assert.equal(count, 3);
  await rm(index.dir, { recursive: true, force: true });
  await rm(memoryDir, { recursive: true, force: true });
});

test("session_search degrades to a structured code when the index is unusable", async () => {
  const { dir: memoryDir, env } = await makeProfile();
  const missing = join(memoryDir, "missing.sqlite");
  const result = await callTool(
    { ...env, AGENT_MEMORY_SOURCES: JSON.stringify([{ backend: "pi", db: missing }]) },
    "session_search",
    { query: "anything" },
  );
  assert.equal(result.payload.ok, true);
  assert.deepEqual(result.payload.hits, []);
  assert.equal(result.payload.error?.code, "session-index-unavailable");
  assert.equal(
    existsSync(missing),
    false,
    "a missing index must not be created by the search",
  );
  await rm(memoryDir, { recursive: true, force: true });
});

test("memory_status reports overBudget and scope list", async () => {
  const { dir, env } = await makeProfile();
  const status = await callTool(env, "memory_status", {});
  assert.equal(status.payload.ok, true);
  assert.ok(Array.isArray(status.payload.scopes));
  assert.equal(status.payload.projectKey.startsWith("demo-"), true, "project key derives from cwd");
  await rm(dir, { recursive: true, force: true });
});

test("the server exposes exactly the seven documented tools", async () => {
  const { dir, env } = await makeProfile();
  const tools = await listTools(env);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "memory_add",
      "memory_get",
      "memory_remove",
      "memory_replace",
      "memory_search",
      "memory_status",
      "session_search",
    ],
  );
  await rm(dir, { recursive: true, force: true });
});
