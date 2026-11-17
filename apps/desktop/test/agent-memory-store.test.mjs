/**
 * Memory store surface for the settings panel (ADR agent-long-term-memory,
 * rollout 4): usage, export, and import over the Markdown files.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MEMORY_PACKAGE_KIND,
  exportMemoryPackage,
  importMemoryPackage,
  listProjectKeys,
  readMemoryStatus,
  validateMemoryPackage,
} from "../electron/main/agent-memory-store.ts";

const SEP = "\n§\n";

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-store-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeEntries(dir, file, entries) {
  const target = join(dir, file);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, entries.join(SEP) + "\n", "utf8");
}

test("status reports entries, chars, and budgets for every scope", async () => {
  await withDir(async (dir) => {
    await writeEntries(dir, "MEMORY.md", ["alpha", "beta"]);
    await writeEntries(dir, "USER.md", ["profile"]);
    await writeEntries(dir, "failures.md", ["[build] learned"]);
    await writeEntries(dir, "projects/demo-11111111/MEMORY.md", ["project fact"]);

    const status = readMemoryStatus(dir);
    const byId = new Map(status.scopes.map((scope) => [scope.id, scope]));
    assert.equal(byId.get("memory").entries, 2);
    assert.equal(byId.get("memory").maxEntries, 400);
    assert.equal(byId.get("user").entries, 1);
    assert.equal(byId.get("failure").entries, 1);
    assert.equal(byId.get("standing").entries, 0);
    assert.equal(byId.get("demo-11111111:memory").entries, 1);
    assert.equal(byId.get("demo-11111111:memory").projectId, "demo-11111111");
    assert.equal(status.totalEntries, 5);
    assert.deepEqual(status.projects, ["demo-11111111"]);
    assert.equal(
      status.scopes.every((scope) => scope.overBudget === false),
      true,
    );
  });
});

test("an over-budget scope is marked instead of silently trimmed on read", async () => {
  await withDir(async (dir) => {
    const entries = Array.from({ length: 41 }, (_, index) => `standing ${index}`);
    await writeEntries(dir, "STANDING.md", entries);
    const scope = readMemoryStatus(dir).scopes.find((item) => item.id === "standing");
    assert.equal(scope.entries, 41);
    assert.equal(scope.maxEntries, 40);
    assert.equal(scope.overBudget, true);
  });
});

test("export never includes device-local memory", async () => {
  await withDir(async (dir) => {
    await writeEntries(dir, "MEMORY.md", ["global"]);
    await writeEntries(dir, "USER.md", ["user"]);
    await writeEntries(dir, "devices/local/MEMORY.md", ["D:/only-on-this-machine"]);
    await writeEntries(dir, "projects/p-22222222/MEMORY.md", ["project"]);
    await writeEntries(dir, "projects/p-22222222/failures.md", ["[test] project lesson"]);

    const pkg = exportMemoryPackage(dir, new Date("2026-11-17T00:00:00Z"));
    assert.equal(pkg.kind, MEMORY_PACKAGE_KIND);
    assert.equal(pkg.exportedAt, "2026-11-17T00:00:00.000Z");
    assert.deepEqual(pkg.scopes.memory, ["global"]);
    assert.deepEqual(pkg.projects["p-22222222"], {
      memory: ["project"],
      failures: ["[test] project lesson"],
    });
    const serialized = JSON.stringify(pkg);
    assert.equal(serialized.includes("only-on-this-machine"), false);
    assert.equal(serialized.includes("devices"), false);
  });
});

test("a package survives a round trip through JSON", async () => {
  await withDir(async (dir) => {
    await writeEntries(dir, "MEMORY.md", ["one", "two"]);
    const pkg = exportMemoryPackage(dir);
    const parsed = JSON.parse(JSON.stringify(pkg));
    assert.equal(validateMemoryPackage(parsed), true);
  });
});

test("import merges, dedupes, and respects budgets oldest-first", async () => {
  await withDir(async (target) => {
    await writeEntries(target, "MEMORY.md", ["existing fact"]);
    const pkg = {
      kind: MEMORY_PACKAGE_KIND,
      version: 1,
      exportedAt: "2026-11-17T00:00:00Z",
      scopes: { memory: ["existing fact", "new fact", "new fact"] },
      projects: {},
      tombstones: [],
    };
    const result = importMemoryPackage(target, pkg);
    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 2);
    const file = await readFile(join(target, "MEMORY.md"), "utf8");
    assert.deepEqual(file.trim().split(SEP), ["existing fact", "new fact"]);
  });
});

test("import keeps tombstoned entries out even when the package carries them", async () => {
  await withDir(async (target) => {
    await writeFile(
      join(target, "tombstones.json"),
      JSON.stringify([`${join(target, "MEMORY.md")}:old fact`]),
      "utf8",
    );
    const pkg = {
      kind: MEMORY_PACKAGE_KIND,
      version: 1,
      exportedAt: "2026-11-17T00:00:00Z",
      scopes: { memory: ["old fact", "fresh fact"] },
      projects: {},
      tombstones: [],
    };
    const result = importMemoryPackage(target, pkg);
    assert.equal(result.tombstoned, 1);
    assert.equal(result.added, 1);
    const file = await readFile(join(target, "MEMORY.md"), "utf8");
    assert.equal(file.includes("old fact"), false);
    assert.match(file, /fresh fact/);
  });
});

test("import restores project scopes and rejects path-escaping keys", async () => {
  await withDir(async (target) => {
    const pkg = {
      kind: MEMORY_PACKAGE_KIND,
      version: 1,
      exportedAt: "2026-11-17T00:00:00Z",
      scopes: {},
      projects: {
        "demo-33333333": { memory: ["project fact"], failures: ["[test] lesson"] },
        "../escape": { memory: ["nope"], failures: [] },
      },
      tombstones: [],
    };
    const result = importMemoryPackage(target, pkg);
    assert.equal(result.added, 2, "only the valid project is imported");
    assert.equal(
      existsSync(join(target, "projects", "demo-33333333", "MEMORY.md")),
      true,
    );
    assert.equal(existsSync(join(target, "escape")), false);
    assert.deepEqual(listProjectKeys(target), ["demo-33333333"]);
  });
});

test("import caps oversized entries like a hand-written one", async () => {
  await withDir(async (target) => {
    const huge = "x".repeat(5000);
    const pkg = {
      kind: MEMORY_PACKAGE_KIND,
      version: 1,
      exportedAt: "2026-11-17T00:00:00Z",
      scopes: { memory: [huge] },
      projects: {},
      tombstones: [],
    };
    importMemoryPackage(target, pkg);
    const file = await readFile(join(target, "MEMORY.md"), "utf8");
    assert.equal(file.trim().length, 2000);
  });
});

test("validation rejects foreign and malformed packages", async () => {
  const base = {
    kind: MEMORY_PACKAGE_KIND,
    version: 1,
    exportedAt: "2026-11-17T00:00:00Z",
    scopes: {},
    projects: {},
    tombstones: [],
  };
  assert.equal(validateMemoryPackage(base), true);
  assert.equal(validateMemoryPackage({ ...base, kind: "something-else" }), false);
  assert.equal(validateMemoryPackage({ ...base, version: 99 }), false);
  assert.equal(validateMemoryPackage({ ...base, scopes: { memory: "nope" } }), false);
  assert.equal(
    validateMemoryPackage({ ...base, projects: { p: { memory: [1] } } }),
    false,
  );
  assert.equal(validateMemoryPackage(null), false);
  assert.equal(validateMemoryPackage("package"), false);
});
