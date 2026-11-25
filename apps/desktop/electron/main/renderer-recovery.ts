export type RendererGoneDetails = Readonly<{
  reason: string;
  exitCode: number;
}>;

export type RendererRecoveryDependencies = Readonly<{
  isCurrentWindow: boolean;
  quitting: boolean;
  windowCloseAccepted: boolean;
  windowDestroyed: boolean;
  webContentsDestroyed: boolean;
  reload: () => void;
  log: (details: RendererGoneDetails, reloaded: boolean) => void;
}>;

/**
 * Minimum milliseconds between automatic reloads. A renderer that crashes
 * again within this window is still reloaded, but the reload is delayed so
 * the process is not spinning in a tight crash loop.
 */
const CRASH_COOLDOWN_MS = 2_000;

/**
 * Reload ceiling per rolling minute. A cooldown alone still reloads a
 * deterministic crash every two seconds forever: the window keeps flashing,
 * the log fills with the same crash, and the failure never becomes visible.
 * After the ceiling is spent the window stays down so the crash can be read
 * and reported; the budget refills as the crashes age out of the window.
 */
const CRASH_RELOAD_LIMIT = 3;
const CRASH_RELOAD_WINDOW_MS = 60_000;

/** Tracks the last reload timestamp per recovery call site. */
let lastReloadTimestamp = 0;
let reloadTimestamps: number[] = [];

const pruneReloads = (now: number): void => {
  reloadTimestamps = reloadTimestamps.filter((time) => now - time < CRASH_RELOAD_WINDOW_MS);
};

/**
 * Reset internal cooldown and budget state. Exposed exclusively for
 * deterministic tests; production code must never call this.
 */
export function _resetCooldownForTest(): void {
  lastReloadTimestamp = 0;
  reloadTimestamps = [];
}

/** Reload an unexpectedly exited renderer while its owning app window is live. */
export function recoverRendererAfterGone(
  details: RendererGoneDetails,
  dependencies: RendererRecoveryDependencies,
): boolean {
  const now = Date.now();
  pruneReloads(now);
  const shouldReload =
    details.reason !== "clean-exit" &&
    dependencies.isCurrentWindow &&
    !dependencies.quitting &&
    !dependencies.windowCloseAccepted &&
    !dependencies.windowDestroyed &&
    !dependencies.webContentsDestroyed &&
    reloadTimestamps.length < CRASH_RELOAD_LIMIT;

  dependencies.log(details, shouldReload);
  if (!shouldReload) return false;

  const elapsed = now - lastReloadTimestamp;
  lastReloadTimestamp = now;
  reloadTimestamps.push(now);

  if (elapsed < CRASH_COOLDOWN_MS) {
    // Delay the reload to avoid a tight crash loop. The timer is short
    // enough that the user sees a brief blank rather than a frozen app.
    setTimeout(() => dependencies.reload(), CRASH_COOLDOWN_MS - elapsed);
  } else {
    dependencies.reload();
  }

  return true;
}
