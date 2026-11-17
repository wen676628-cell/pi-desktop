import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSync } from "esbuild";

test("workspace file index and search fall back at the Git deadline without a close event", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-index-deadline-"));
  await writeFile(join(root, "note.txt"), "fixture");
  const require = createRequire(import.meta.url);
  const processModule = require("node:child_process");
  const originalSpawn = processModule.spawn;
  let spawned;
  const ready = new Promise(resolve => { spawned = resolve; });
  let killed = false;
  processModule.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdout.destroy = () => {};
    child.stderr = new EventEmitter();
    child.stderr.destroy = () => {};
    child.kill = () => { killed = true; return true; };
    spawned();
    return child;
  };
  try {
    const result = buildSync({ entryPoints: [fileURLToPath(new URL("../../../packages/host-runtime/src/fs-index.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" });
    const module = { exports: {} };
    new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let listing;
    let failure;
    const pending = module.exports.getWorkspaceFileIndex(root).then(
      value => { listing = value; },
      error => { failure = error; },
    );
    await ready;
    t.mock.timers.tick(4000);
    assert.equal(killed, true);
    // The Git deadline was the only mocked timer this test needs. Restoring
    // real timers lets the fallback walk settle on I/O completion instead of
    // a fixed spin count: how many event-loop turns a `readdir` needs is a
    // property of the machine, not of the contract under test, and a budgeted
    // spin failed on slower runners with the file index still pending.
    t.mock.timers.reset();
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.ok(settled, "the file index must settle after the Git deadline");
    assert.equal(failure, undefined, "the file index must not reject");
    assert.ok(listing, "the file index must settle without Git close");
    assert.deepEqual(listing.entries, [{ path: "note.txt", kind: "file" }]);
    await pending;
    assert.deepEqual((await module.exports.searchWorkspaceFiles(root, "note")).entries, listing.entries);
  } finally {
    t.mock.timers.reset();
    processModule.spawn = originalSpawn;
    await rm(root, { recursive: true, force: true });
  }
});
