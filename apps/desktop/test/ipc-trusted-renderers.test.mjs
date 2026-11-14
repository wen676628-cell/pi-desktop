import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isTrustedRenderer,
  registerTrustedRenderer,
  unregisterTrustedRenderer,
} from "../electron/main/ipc/trusted-renderers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const read = (relative) =>
  readFileSync(join(desktopRoot, relative), "utf8");

function stubContents() {
  const listeners = new Map();
  return {
    listeners,
    once(event, handler) {
      listeners.set(event, handler);
    },
    emit(event) {
      listeners.get(event)?.();
    },
  };
}

test("an unregistered sender is not trusted", () => {
  assert.equal(isTrustedRenderer(stubContents()), false);
  assert.equal(isTrustedRenderer(null), false);
  assert.equal(isTrustedRenderer(undefined), false);
});

test("a registered surface is trusted until its contents are destroyed", () => {
  const contents = stubContents();
  registerTrustedRenderer(contents);
  assert.equal(isTrustedRenderer(contents), true);
  contents.emit("destroyed");
  assert.equal(
    isTrustedRenderer(contents),
    false,
    "a destroyed window must stop being a trusted sender",
  );
});

test("explicit unregistration drops the surface immediately", () => {
  const contents = stubContents();
  registerTrustedRenderer(contents);
  unregisterTrustedRenderer(contents);
  assert.equal(isTrustedRenderer(contents), false);
});

test("registering the same contents twice stays one entry", () => {
  const contents = stubContents();
  registerTrustedRenderer(contents);
  registerTrustedRenderer(contents);
  assert.equal(isTrustedRenderer(contents), true);
  contents.emit("destroyed");
  assert.equal(isTrustedRenderer(contents), false);
});

test("every general IPC registration path checks the sender", () => {
  const source = read("electron/main/ipc/register.ts");
  const handle = source.slice(
    source.indexOf("const handle = ("),
    source.indexOf("const handleWithEvent = ("),
  );
  const withEvent = source.slice(
    source.indexOf("const handleWithEvent = ("),
    source.indexOf("const assertMainWindowSender = ("),
  );
  assert.match(handle, /assertTrustedSender\(event\)/);
  assert.match(withEvent, /assertTrustedSender\(event\)/);
  assert.match(
    source,
    /const assertTrustedSender = \(event: IpcMainInvokeEvent\): void =>/,
  );
  assert.match(source, /import \{ isTrustedRenderer \} from "\.\/trusted-renderers"/);
});

test("the three first-party bridge windows register as trusted", () => {
  const windowSrc = read("electron/main/bootstrap/window.ts");
  const launcherSrc = read("electron/main/bootstrap/launcher.ts");
  const widgetSrc = read("electron/main/live-voice/widget-window.ts");
  // Only windows that load the general preload may register.
  assert.match(windowSrc, /preload: join\(getModuleDirectory\(import\.meta\.url\), "\.\.\/preload\/index\.cjs"\)/);
  assert.match(launcherSrc, /preload: join\(getModuleDirectory\(import\.meta\.url\), "\.\.\/preload\/index\.cjs"\)/);
  assert.match(widgetSrc, /preload: join\(getModuleDirectory\(import\.meta\.url\), "\.\.\/preload\/index\.cjs"\)/);
  assert.match(windowSrc, /registerTrustedRenderer\(window\.webContents\)/);
  assert.match(launcherSrc, /registerTrustedRenderer\(window\.webContents\)/);
  assert.match(widgetSrc, /registerTrustedRenderer\(created\.webContents\)/);
});

test("narrow-bridge surfaces never register as trusted senders", () => {
  const panelSrc = read("electron/main/plugin-panel-host.ts");
  const viewSrc = read("electron/main/plugin-view-host.ts");
  const backingSrc = read("electron/main/browser-backing-host.ts");
  for (const [name, source] of [
    ["plugin panel", panelSrc],
    ["plugin view", viewSrc],
    ["browser backing host", backingSrc],
  ]) {
    assert.doesNotMatch(
      source,
      /registerTrustedRenderer/,
      `${name} must not join the trusted sender set`,
    );
  }
  // The panel/view surfaces carry the narrow plugin bridge, not the general one.
  assert.match(panelSrc, /preload\/plugin-panel\.js/);
  assert.match(viewSrc, /preload\/plugin-panel\.js/);
  assert.doesNotMatch(backingSrc, /preload/);
});
