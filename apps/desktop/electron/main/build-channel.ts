/**
 * Main-process build-channel reader (ADR dev-channel-parallel-installation).
 *
 * `extraMetadata` writes `piChannel` into the packaged package.json, the same
 * mechanism `piDistribution` already uses for the updater. Reading it here
 * keeps the channel a build fact rather than a setting a user can flip.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { resolveBuildChannel, type BuildChannel } from "../../src/lib/build-channel.ts";

let cached: BuildChannel | null = null;

/** The channel this build was packaged as; an unpackaged run is stable. */
export function currentBuildChannel(): BuildChannel {
  if (cached) return cached;
  if (!app.isPackaged) {
    cached = "stable";
    return cached;
  }
  try {
    const packageJson = JSON.parse(
      readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
    ) as unknown;
    cached = resolveBuildChannel(packageJson);
  } catch {
    // A build without readable metadata is treated as stable: shipping an
    // experimental channel by accident is worse than losing the marker.
    cached = "stable";
  }
  return cached;
}

/** Test seam: forget the resolved channel. */
export function resetBuildChannelCache(): void {
  cached = null;
}
