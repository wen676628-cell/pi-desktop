/**
 * Dev-channel data sharing (ADR dev-channel-parallel-installation, rollout 2).
 *
 * A Dev build gets its own userData and its own `~/.pi-desktop-dev` root, so it
 * can sit beside a stable installation. On its first launch it may instead
 * choose to share stable's data root — useful for reproducing a bug against
 * real sessions, and dangerous enough that the choice is asked once, stored,
 * and stated plainly in the dialog.
 *
 * This module is pure filesystem logic over explicit paths so the decision can
 * be tested without Electron; the dialog and the actual wiring live in the
 * entries that call it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEV_SHARING_FILE = "dev-sharing.json";
const DEV_SHARING_VERSION = 1;

export type DevSharingChoice = "shared" | "independent";

export type DevSharingInputs = {
  /** The Dev build's own userData directory. */
  devUserDataDir: string;
  /** The platform's `appData` directory (parent of both userData folders). */
  appDataDir: string;
  /** The user's home directory; the stable data root lives below it. */
  home: string;
};

export type StableProfile = {
  userDataDir: string;
  dataDir: string;
};

/** Stable's two directories, derived from the same names the app already uses. */
export function stableProfile(appDataDir: string, home: string): StableProfile {
  return {
    userDataDir: join(appDataDir, "PI-Desktop"),
    dataDir: join(home, ".pi-desktop"),
  };
}

/**
 * Where stable keeps its data today: its `storage-location.json` when that
 * points at an existing directory, otherwise the default root. `null` means
 * there is no stable installation to share with.
 */
export function detectStableDataDir(appDataDir: string, home: string): string | null {
  const profile = stableProfile(appDataDir, home);
  const preferenceFile = join(profile.userDataDir, "storage-location.json");
  try {
    if (existsSync(preferenceFile)) {
      const parsed = JSON.parse(readFileSync(preferenceFile, "utf8")) as {
        roots?: { data?: unknown };
      };
      const data = parsed.roots?.data;
      if (typeof data === "string" && data.trim() && existsSync(data)) {
        return data;
      }
    }
  } catch {
    // A malformed preference is stable's problem, not this build's: fall back
    // to the default root instead of refusing to start.
  }
  return existsSync(profile.dataDir) ? profile.dataDir : null;
}

/** The stored decision, if this Dev build already asked. */
export function readDevSharingChoice(devUserDataDir: string): DevSharingChoice | null {
  try {
    const file = join(devUserDataDir, DEV_SHARING_FILE);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown;
      choice?: unknown;
    };
    if (parsed.version !== DEV_SHARING_VERSION) return null;
    return parsed.choice === "shared" || parsed.choice === "independent"
      ? parsed.choice
      : null;
  } catch {
    return null;
  }
}

/** Persist the decision; atomic so a crash cannot leave a half-written marker. */
export function writeDevSharingChoice(
  devUserDataDir: string,
  choice: DevSharingChoice,
  now = new Date(),
): void {
  mkdirSync(devUserDataDir, { recursive: true });
  const file = join(devUserDataDir, DEV_SHARING_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(
    temp,
    `${JSON.stringify({ version: DEV_SHARING_VERSION, choice, chosenAt: now.toISOString() }, null, 2)}\n`,
    "utf8",
  );
  renameSync(temp, file);
}

/**
 * True when a Dev build must ask before choosing a data root: it has no stored
 * choice and there is a stable installation whose data it could share.
 */
export function needsSharingDecision(inputs: DevSharingInputs): boolean {
  if (readDevSharingChoice(inputs.devUserDataDir)) return false;
  return detectStableDataDir(inputs.appDataDir, inputs.home) !== null;
}

/**
 * The data root a Dev build should use: stable's when it chose to share and
 * that root still exists, otherwise its own default.
 */
export function resolveDevDataDir(
  choice: DevSharingChoice | null,
  stableDataDir: string | null,
  devDataDir: string,
): string {
  if (choice === "shared" && stableDataDir && existsSync(stableDataDir)) {
    return stableDataDir;
  }
  return devDataDir;
}
