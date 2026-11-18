/**
 * IPC trust boundary (P1/P2 of the 2026-11-17 review).
 *
 * The general IPC bridge only answers renderers that registered in
 * `trusted-renderers.ts`: the main window, the live-voice widget, and the
 * plugin launcher. Two failure modes matter and neither is visible at runtime
 * until a surface is already broken:
 *
 *   - a first-party window forgets to register → the whole app gets
 *     PERMISSION_DENIED;
 *   - a non-first-party surface (plugin panel, browser view) registers or a new
 *     `ipcMain.handle` is added outside the wrapper → the trust gate is bypassed.
 *
 * Biome cannot express either rule, so they live here as source-contract tests:
 * the channel allowlist makes a new outside-the-wrapper handler a deliberate,
 * reviewed change instead of an accident.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mainRoot = join(repoRoot, "apps/desktop/electron/main");
const read = (path) => readFileSync(path, "utf8");

/** Every TS file under electron/main, with its repo-relative path. */
function mainSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(mainRoot);
  return files;
}

const rel = (path) => relative(repoRoot, path).replaceAll("\\", "/");

/** Count of `registerTrustedRenderer(` call sites, excluding the export itself. */
function registrationCallSites() {
  const sites = [];
  for (const file of mainSources()) {
    const source = read(file);
    if (!source.includes("registerTrustedRenderer(")) continue;
    if (rel(file) === "apps/desktop/electron/main/ipc/trusted-renderers.ts") continue;
    sites.push(rel(file));
  }
  return sites.sort();
}

test("exactly the three first-party surfaces register as trusted senders", () => {
  assert.deepEqual(registrationCallSites(), [
    "apps/desktop/electron/main/bootstrap/launcher.ts",
    "apps/desktop/electron/main/bootstrap/window.ts",
    "apps/desktop/electron/main/live-voice/widget-window.ts",
  ]);
});

test("each registration sits beside a window that loads the general preload", () => {
  const expectations = [
    ["apps/desktop/electron/main/bootstrap/window.ts", "../preload/index.cjs"],
    ["apps/desktop/electron/main/bootstrap/launcher.ts", "../preload/index.cjs"],
    ["apps/desktop/electron/main/live-voice/widget-window.ts", "../preload/index.cjs"],
  ];
  for (const [file, preload] of expectations) {
    const source = read(join(repoRoot, file));
    assert.match(source, /registerTrustedRenderer\(/, `${file} must register its surface`);
    assert.ok(
      source.includes(preload),
      `${file} must load the general preload bridge it registers for`,
    );
  }
});

test("plugin panels stay outside the trust set and use their own preload", () => {
  const panel = read(join(mainRoot, "plugin-panel-host.ts"));
  assert.doesNotMatch(
    panel,
    /registerTrustedRenderer\s*\(/,
    "a plugin panel is untrusted by design; registering it would grant the general bridge",
  );
  assert.match(panel, /\.\.\/preload\/plugin-panel\.js/);
  assert.match(panel, /"pi-plugin-panel-invoke"/);
});

test("the general bridge registers through the wrapper that checks the sender", () => {
  const register = read(join(mainRoot, "ipc/register.ts"));
  // Both wrappers assert before doing anything with the payload.
  const handle = register.slice(register.indexOf("const handle = ("), register.indexOf("const handleWithEvent = ("));
  const withEvent = register.slice(register.indexOf("const handleWithEvent = ("), register.indexOf("const assertMainWindowSender = ("));
  assert.match(handle, /ipcMain\.handle\(channel,[^]*?assertTrustedSender\(event\);[^]*?return handler/);
  assert.match(withEvent, /ipcMain\.handle\(channel,[^]*?assertTrustedSender\(event\);[^]*?return fn\(event/);
  // A rejection names the surface, so a missing registration is diagnosable.
  assert.match(register, /sender is not a trusted renderer\$\{surface\}/);
});

test("ipcMain handlers outside the wrapper are the panel channels and nothing else", () => {
  const allowed = new Map([
    [
      "apps/desktop/electron/main/plugin-panel-host.ts",
      new Set([
        "pi-plugin-panel-invoke",
        "pi-plugin-panel-drop",
        "pi-plugin-panel-bridge",
        // The panel capsule's own window controls (getState/close/minimize).
        "PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL",
      ]),
    ],
  ]);

  const offenders = [];
  for (const file of mainSources()) {
    if (rel(file) === "apps/desktop/electron/main/ipc/register.ts") continue;
    const source = read(file);
    for (const match of source.matchAll(/ipcMain\.(handle|handleOnce|on|once)\(\s*([^,)]+)/g)) {
      const name = match[2].trim();
      const literal = name.match(/^["'`]([^"'`]+)["'`]$/)?.[1] ?? name;
      const permitted = allowed.get(rel(file));
      if (!permitted || !permitted.has(literal)) {
        offenders.push(`${rel(file)}: ${literal}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a handler outside ipc/register.ts bypasses assertTrustedSender: move it into the wrapper, " +
      "or add the panel-scoped channel to the allowlist above with a comment saying why it cannot " +
      "reach the general bridge",
  );
});

test("unregistered, foreign, and destroyed senders are rejected", async () => {
  const { registerTrustedRenderer, unregisterTrustedRenderer, isTrustedRenderer } =
    await import("../electron/main/ipc/trusted-renderers.ts");

  class FakeContents extends EventEmitter {
    constructor(id = 1) {
      super();
      this.id = id;
      this.destroyed = false;
      this.onceFired = 0;
    }
    once(event, listener) {
      this.onceFired += 1;
      return super.once(event, listener);
    }
  }

  const foreign = new FakeContents(1);
  assert.equal(isTrustedRenderer(foreign), false, "a window that never registered cannot invoke");
  assert.equal(isTrustedRenderer(undefined), false);
  assert.equal(isTrustedRenderer(null), false);

  const firstParty = new FakeContents(2);
  registerTrustedRenderer(firstParty);
  assert.equal(isTrustedRenderer(firstParty), true);
  assert.equal(firstParty.onceFired, 1, "the trust set listens for the surface going away");

  // Destroying the surface drops it, so a recycled WebContents id cannot inherit trust.
  firstParty.emit("destroyed");
  assert.equal(isTrustedRenderer(firstParty), false);

  // Explicit teardown behaves the same way.
  const manual = new FakeContents(3);
  registerTrustedRenderer(manual);
  unregisterTrustedRenderer(manual);
  assert.equal(isTrustedRenderer(manual), false);

  // Registering twice is harmless (both paths call it on re-creation).
  const repeat = new FakeContents(4);
  registerTrustedRenderer(repeat);
  registerTrustedRenderer(repeat);
  assert.equal(isTrustedRenderer(repeat), true);
});

test("the review's verification command still finds only the wrapper", () => {
  // The exact check P2 asked for, kept runnable inside CI.
  const hits = [];
  for (const file of mainSources()) {
    if (rel(file) === "apps/desktop/electron/main/ipc/register.ts") continue;
    const source = read(file);
    if (/ipcMain\.handle\s*\(/.test(source)) hits.push(rel(file));
  }
  assert.deepEqual(hits, ["apps/desktop/electron/main/plugin-panel-host.ts"]);
});
