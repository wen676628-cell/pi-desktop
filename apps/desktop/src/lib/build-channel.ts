/**
 * Build channel (ADR dev-channel-parallel-installation).
 *
 * A channel is chosen by the build command, never by the version string: a
 * `-beta` version packaged by the stable command is still a stable build. The
 * dev channel gets its own appId, productName, artifact prefix, userData
 * directory, and updater feed, so stable and Dev install side by side.
 *
 * This module is the pure half (no Electron import) so the resolver can be
 * tested directly; the main-process reader lives in electron/main.
 */

export type BuildChannel = "stable" | "dev";

/** Stable and Dev must never share an installation identity. */
export const CHANNEL_IDENTITY = {
  stable: { appId: "net.aiuo.pi-desktop", productName: "PI-Desktop" },
  dev: { appId: "net.aiuo.pi-desktop.dev", productName: "PI-Desktop Dev" },
} as const;

/**
 * Read `piChannel` out of a packaged package.json payload. Anything other than
 * an explicit `"dev"` is stable, so a missing or malformed field degrades to
 * the shipped channel rather than to the experimental one.
 */
export function resolveBuildChannel(metadata: unknown): BuildChannel {
  if (typeof metadata !== "object" || metadata === null) return "stable";
  return (metadata as Record<string, unknown>).piChannel === "dev" ? "dev" : "stable";
}

export function channelAppId(channel: BuildChannel): string {
  return CHANNEL_IDENTITY[channel].appId;
}

export function channelProductName(channel: BuildChannel): string {
  return CHANNEL_IDENTITY[channel].productName;
}

/** Artifact prefix: `PI-Desktop-Setup-…` vs `PI-Desktop-Dev-Setup-…`. */
export function channelArtifactPrefix(channel: BuildChannel): string {
  return channel === "dev" ? "PI-Desktop-Dev" : "PI-Desktop";
}

/** True when two builds would share an install identity. */
export function sharesIdentity(a: BuildChannel, b: BuildChannel): boolean {
  return a === b;
}
