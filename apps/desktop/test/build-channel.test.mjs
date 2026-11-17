/**
 * Build channel plumbing (ADR dev-channel-parallel-installation, rollout 1).
 *
 * The channel is a build fact: the packaging script decides it, `extraMetadata`
 * records it, and the packaged app reads it back. These tests pin the three
 * halves so a Dev build can never silently share stable's install identity.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_IDENTITY,
  channelAppId,
  channelArtifactPrefix,
  channelProductName,
  resolveBuildChannel,
  sharesIdentity,
} from "../src/lib/build-channel.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const packageJson = JSON.parse(read("apps/desktop/package.json"));

/** `-c.key=value` flags as a map; values may themselves contain '='. */
const flagsOf = (invocation) =>
  new Map(
    invocation
      .filter((arg) => arg.startsWith("-c."))
      .map((arg) => {
        const eq = arg.indexOf("=");
        return [arg.slice(0, eq), arg.slice(eq + 1)];
      }),
  );

test("only an explicit piChannel=dev selects the dev channel", () => {
  assert.equal(resolveBuildChannel({ piChannel: "dev" }), "dev");
  // A stable or malformed marker degrades to stable: shipping the experimental
  // identity by accident is worse than losing the marker.
  assert.equal(resolveBuildChannel({ piChannel: "stable" }), "stable");
  assert.equal(resolveBuildChannel({ piChannel: "DEV" }), "stable");
  assert.equal(resolveBuildChannel({}), "stable");
  assert.equal(resolveBuildChannel({ piChannel: 1 }), "stable");
  assert.equal(resolveBuildChannel(null), "stable");
  assert.equal(resolveBuildChannel(undefined), "stable");
});

test("channels never share an install identity", () => {
  assert.notEqual(channelAppId("stable"), channelAppId("dev"));
  assert.notEqual(channelProductName("stable"), channelProductName("dev"));
  assert.equal(channelArtifactPrefix("stable"), "PI-Desktop");
  assert.equal(channelArtifactPrefix("dev"), "PI-Desktop-Dev");
  assert.equal(sharesIdentity("stable", "dev"), false);
  // The packaged defaults stay stable's, so an unflagged build is unchanged.
  assert.equal(packageJson.build.appId, CHANNEL_IDENTITY.stable.appId);
  assert.equal(packageJson.build.productName, CHANNEL_IDENTITY.stable.productName);
});

test("the packaging script takes the channel from the command, not the version", () => {
  const script = read("scripts/build-desktop-release.mjs");
  assert.match(script, /--channel/);
  assert.match(script, /extraMetadata\.piChannel=/);
  assert.match(script, /-c\.appId=\$\{channelAppId\(channel\)\}/);
  assert.match(script, /-c\.productName=\$\{channelProductName\(channel\)\}/);
  // Every artifact template carries the channel prefix, so a Dev build cannot
  // produce a file named like a stable release.
  for (const target of ["mac", "linux", "win", "nsis", "portable"]) {
    assert.match(
      script,
      new RegExp(`-c\\.${target}\\.artifactName=\\$\\{artifactPrefix\\}`),
      `${target} artifactName must use the channel prefix`,
    );
  }
  // No version sniffing anywhere: the channel never comes from the package
  // version or a `-beta` suffix.
  assert.doesNotMatch(script, /version\.includes\(|-\s*beta/);
});

test("dev packaging commands exist for all three desktop platforms", () => {
  for (const script of ["dist:win:dev", "dist:mac:dev", "dist:linux:dev"]) {
    const command = packageJson.scripts[script];
    assert.ok(command, `${script} is missing`);
    assert.match(command, /--channel dev/);
  }
  // Stable commands keep their existing lanes; a Dev flag must not leak in.
  for (const script of ["dist:win", "dist", "dist:mac", "dist:linux"]) {
    assert.doesNotMatch(packageJson.scripts[script] ?? "", /--channel/, script);
  }
});

test("the packaged app reads the channel from its own metadata", () => {
  const source = read("apps/desktop/electron/main/build-channel.ts");
  assert.match(source, /app\.isPackaged/);
  assert.match(source, /app\.getAppPath\(\)/);
  assert.match(source, /resolveBuildChannel/);
  // Unreadable metadata must degrade to stable, never to dev.
  assert.match(source, /catch[^]*?cached = "stable"/);
});

test("a Dev packaging run would hand electron-builder the Dev identity", () => {
  const run = (args) => {
    const result = spawnSync(process.execPath, ["scripts/build-desktop-release.mjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => JSON.parse(line));
  };

  const devInvocations = run(["win", "--channel", "dev", "--dry-run"]);
  assert.equal(devInvocations.length, 3, "nsis, zip, and portable are each packaged");
  for (const invocation of devInvocations) {
    const flags = flagsOf(invocation);
    assert.equal(flags.get("-c.appId"), "net.aiuo.pi-desktop.dev");
    assert.equal(flags.get("-c.productName"), "PI-Desktop Dev");
    assert.equal(flags.get("-c.extraMetadata.piChannel"), "dev");
    assert.equal(flags.get("-c.nsis.artifactName"), "PI-Desktop-Dev-Setup-${version}.${ext}");
    assert.equal(flags.get("-c.portable.artifactName"), "PI-Desktop-Dev-Portable-${version}.${ext}");
  }
  // Each Windows distribution still records which form it is.
  assert.deepEqual(
    devInvocations.map((invocation) =>
      invocation.find((arg) => arg.startsWith("-c.extraMetadata.piDistribution=")),
    ),
    [
      "-c.extraMetadata.piDistribution=installed",
      "-c.extraMetadata.piDistribution=zip",
      "-c.extraMetadata.piDistribution=portable",
    ],
  );

  // The same command without the flag stays stable's identity.
  const stableInvocations = run(["win", "--dry-run"]);
  for (const invocation of stableInvocations) {
    const flags = flagsOf(invocation);
    assert.equal(flags.get("-c.appId"), "net.aiuo.pi-desktop");
    assert.equal(flags.get("-c.productName"), "PI-Desktop");
    assert.equal(flags.get("-c.extraMetadata.piChannel"), "stable");
    assert.equal(flags.get("-c.nsis.artifactName"), "PI-Desktop-Setup-${version}.${ext}");
    assert.ok(!invocation.join(" ").includes("PI-Desktop-Dev-"), "stable must not use a Dev prefix");
  }
});

test("an unknown channel is rejected before any packaging starts", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/build-desktop-release.mjs", "win", "--channel", "beta", "--dry-run"],
    { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported desktop release channel: beta/);
  assert.doesNotMatch(result.stdout, /electron-builder/);
});
