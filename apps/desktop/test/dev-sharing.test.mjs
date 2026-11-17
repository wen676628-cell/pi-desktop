/**
 * Dev-channel first-launch data choice (ADR dev-channel-parallel-installation,
 * rollout 2): detect a stable installation, ask once, remember the answer, and
 * fall back to the Dev profile when a shared root disappears.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEV_SHARING_FILE,
  detectStableDataDir,
  needsSharingDecision,
  readDevSharingChoice,
  resolveDevDataDir,
  stableProfile,
  writeDevSharingChoice,
} from "../electron/main/dev-sharing.ts";

async function withRoots(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-dev-sharing-"));
  const appDataDir = join(root, "appData");
  const home = join(root, "home");
  const devUserDataDir = join(appDataDir, "PI-Desktop Dev");
  await mkdir(appDataDir, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    await run({ root, appDataDir, home, devUserDataDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("stable's two directories follow the names the app already uses", () => {
  const profile = stableProfile("/appData", "/home/u");
  assert.equal(profile.userDataDir, join("/appData", "PI-Desktop"));
  assert.equal(profile.dataDir, join("/home/u", ".pi-desktop"));
});

test("no stable installation means nothing to share", async () => {
  await withRoots(async ({ appDataDir, home }) => {
    assert.equal(detectStableDataDir(appDataDir, home), null);
  });
});

test("an existing default data root is detected", async () => {
  await withRoots(async ({ appDataDir, home }) => {
    await mkdir(join(home, ".pi-desktop"), { recursive: true });
    assert.equal(detectStableDataDir(appDataDir, home), join(home, ".pi-desktop"));
  });
});

test("stable's relocated root wins over the default one", async () => {
  await withRoots(async ({ root, appDataDir, home }) => {
    const relocated = join(root, "moved-data");
    await mkdir(relocated, { recursive: true });
    await mkdir(join(home, ".pi-desktop"), { recursive: true });
    await mkdir(join(appDataDir, "PI-Desktop"), { recursive: true });
    await writeFile(
      join(appDataDir, "PI-Desktop", "storage-location.json"),
      JSON.stringify({ version: 1, roots: { data: relocated, browser: "x" }, backups: [] }),
      "utf8",
    );
    assert.equal(detectStableDataDir(appDataDir, home), relocated);
  });
});

test("a malformed preference falls back to the default root instead of failing", async () => {
  await withRoots(async ({ appDataDir, home }) => {
    await mkdir(join(home, ".pi-desktop"), { recursive: true });
    await mkdir(join(appDataDir, "PI-Desktop"), { recursive: true });
    await writeFile(join(appDataDir, "PI-Desktop", "storage-location.json"), "{ nope", "utf8");
    assert.equal(detectStableDataDir(appDataDir, home), join(home, ".pi-desktop"));
  });
});

test("a preference pointing at a missing directory is not offered", async () => {
  await withRoots(async ({ root, appDataDir, home }) => {
    await mkdir(join(appDataDir, "PI-Desktop"), { recursive: true });
    await writeFile(
      join(appDataDir, "PI-Desktop", "storage-location.json"),
      JSON.stringify({ version: 1, roots: { data: join(root, "gone"), browser: "x" }, backups: [] }),
      "utf8",
    );
    assert.equal(detectStableDataDir(appDataDir, home), null);
  });
});

test("the choice is asked once and remembered", async () => {
  await withRoots(async ({ appDataDir, home, devUserDataDir }) => {
    await mkdir(join(home, ".pi-desktop"), { recursive: true });
    const inputs = { devUserDataDir, appDataDir, home };
    assert.equal(needsSharingDecision(inputs), true);
    writeDevSharingChoice(devUserDataDir, "shared", new Date("2026-11-17T00:00:00Z"));
    assert.equal(needsSharingDecision(inputs), false);
    assert.equal(readDevSharingChoice(devUserDataDir), "shared");
    const stored = JSON.parse(await readFile(join(devUserDataDir, DEV_SHARING_FILE), "utf8"));
    assert.deepEqual(stored, {
      version: 1,
      choice: "shared",
      chosenAt: "2026-11-17T00:00:00.000Z",
    });
  });
});

test("a malformed or unknown marker is treated as never asked", async () => {
  await withRoots(async ({ devUserDataDir }) => {
    await mkdir(devUserDataDir, { recursive: true });
    await writeFile(join(devUserDataDir, DEV_SHARING_FILE), "{ not json", "utf8");
    assert.equal(readDevSharingChoice(devUserDataDir), null);
    await writeFile(
      join(devUserDataDir, DEV_SHARING_FILE),
      JSON.stringify({ version: 99, choice: "shared" }),
      "utf8",
    );
    assert.equal(readDevSharingChoice(devUserDataDir), null);
    await writeFile(
      join(devUserDataDir, DEV_SHARING_FILE),
      JSON.stringify({ version: 1, choice: "both" }),
      "utf8",
    );
    assert.equal(readDevSharingChoice(devUserDataDir), null);
  });
});

test("sharing follows the stored choice only while that root still exists", async () => {
  await withRoots(async ({ root, home }) => {
    const stableDir = join(home, ".pi-desktop");
    const devDir = join(home, ".pi-desktop-dev");
    await mkdir(stableDir, { recursive: true });
    assert.equal(resolveDevDataDir("shared", stableDir, devDir), stableDir);
    assert.equal(resolveDevDataDir("independent", stableDir, devDir), devDir);

    // The shared root disappeared: Dev must still start, in its own folder.
    await rm(stableDir, { recursive: true, force: true });
    assert.equal(resolveDevDataDir("shared", stableDir, devDir), devDir);
    const missing = join(root, "never");
    assert.equal(resolveDevDataDir("shared", missing, devDir), devDir);
    assert.equal(existsSync(devDir), false, "resolution never creates a directory");
  });
});
