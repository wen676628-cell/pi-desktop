import { homedir } from "node:os";
import { app, BrowserWindow, dialog } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { defaultDataDir, hasSingleInstanceLock, isDevelopmentBuild, singleInstanceRequired } from "./installation";
import { currentBuildChannel } from "./build-channel";
import {
  detectStableDataDir,
  needsSharingDecision,
  readDevSharingChoice,
  resolveDevDataDir,
  writeDevSharingChoice,
} from "./dev-sharing";
import { prepareStorage } from "./storage/bootstrap";

/**
 * First-launch data choice for a packaged Dev build (ADR
 * dev-channel-parallel-installation, rollout 2).
 *
 * An unpackaged `pnpm dev` host already owns its profile and is never asked.
 * A Dev build asks once, stores the answer, and uses it from then on; a root
 * that disappears later falls back to Dev's own directory instead of refusing
 * to start.
 */
async function resolveDevDataRoot(): Promise<string> {
  if (isDevelopmentBuild || currentBuildChannel() !== "dev") return defaultDataDir;
  const devUserDataDir = app.getPath("userData");
  const appDataDir = app.getPath("appData");
  const home = homedir();
  const stableDataDir = detectStableDataDir(appDataDir, home);

  if (needsSharingDecision({ devUserDataDir, appDataDir, home })) {
    // Dialogs need a ready app; nothing has been written yet at this point.
    await app.whenReady();
    const copy = catalogs[resolveLocale(app.getLocale())].settings.storage;
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: copy.devShareTitle,
      message: copy.devShareMessage,
      detail: copy.devShareDetail.replace("{path}", stableDataDir ?? ""),
      buttons: [copy.devShareIndependent, copy.devShareShared],
      defaultId: 0,
      cancelId: 0,
    });
    const picked = response === 1 ? "shared" : "independent";
    writeDevSharingChoice(devUserDataDir, picked);
    return resolveDevDataDir(picked, stableDataDir, defaultDataDir);
  }

  return resolveDevDataDir(
    readDevSharingChoice(devUserDataDir),
    stableDataDir,
    defaultDataDir,
  );
}

// Do not top-level-await Electron readiness: module evaluation gates the ready event.
// The full composition root is imported only after offline maintenance has finished.
if (hasSingleInstanceLock) {
  let booted = false;
  app.on("second-instance", () => {
    if (booted) return;
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  void resolveDevDataRoot()
    .then((dataDir) => prepareStorage(dataDir, !singleInstanceRequired))
    .then(() => {
      booted = true;
      return import("./index");
    })
    .catch((error: unknown) => {
      console.error("Storage startup failed", error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
}
