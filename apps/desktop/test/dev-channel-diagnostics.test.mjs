/**
 * Dev-channel updater behaviour and diagnostics marker (ADR
 * dev-channel-parallel-installation, rollout 3).
 *
 * Two contracts:
 *   - the updater's prerelease opt-in follows the build channel, not the
 *     version string;
 *   - the channel travels with the build into bug reports, the About panel,
 *     and the first log line.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBugReportUrl,
  formatFeedbackEnvironment,
} from "../../../packages/shared/src/github-feedback.ts";
import { resolveBuildChannel } from "../src/lib/build-channel.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

test("only the Dev channel opts into prereleases", () => {
  const updater = read("apps/desktop/electron/main/updater.ts");
  assert.match(updater, /allowPrerelease = currentBuildChannel\(\) === "dev"/);
  // The decision must not read the version string: a `-beta` build packaged by
  // the stable command still tracks stable.
  assert.doesNotMatch(updater, /allowPrerelease\s*=\s*[^;]*APP_VERSION/);
  assert.equal(resolveBuildChannel({ piChannel: "dev" }), "dev");
  assert.equal(resolveBuildChannel({}), "stable");
});

test("the channel reaches the About payload and the first log line", () => {
  const appIpc = read("apps/desktop/electron/main/ipc/app-ipc.ts");
  assert.match(appIpc, /channel: currentBuildChannel\(\)/);
  const lifecycle = read("apps/desktop/electron/main/runtime/lifecycle.ts");
  assert.match(lifecycle, /data: \{ protocolVersion: PROTOCOL_VERSION, channel: currentBuildChannel\(\) \}/);
  const about = read("apps/desktop/src/features/settings/pages/AboutSettings.tsx");
  assert.match(about, /version\?\.channel === "dev"/);
});

test("a Dev build says so in the environment line of a bug report", () => {
  const base = {
    version: "0.22.1",
    platform: "win32",
    arch: "x64",
    protocolVersion: 11,
    hostVersion: "0.22.1",
  };
  const stable = formatFeedbackEnvironment(base);
  assert.equal(stable, "PI-Desktop 0.22.1 · win32 x64 · protocol 11 · host 0.22.1");
  const dev = formatFeedbackEnvironment({ ...base, channel: "dev" });
  assert.equal(dev, "PI-Desktop 0.22.1 · Dev build · win32 x64 · protocol 11 · host 0.22.1");

  const url = new URL(buildBugReportUrl({ ...base, channel: "dev" }));
  assert.match(url.searchParams.get("environment") ?? "", /Dev build/);
  // Stable reports keep the exact line they had before the channel existed.
  const stableUrl = new URL(buildBugReportUrl(base));
  assert.doesNotMatch(stableUrl.searchParams.get("environment") ?? "", /Dev build/);
});
