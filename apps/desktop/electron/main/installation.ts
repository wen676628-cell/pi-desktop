import { app } from "electron";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import { applyDevelopmentUserData, desktopDataDir } from "./data-paths";
import { currentBuildChannel } from "./build-channel";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
/**
 * A packaged Dev-channel build needs the same profile split as an unpackaged
 * one: its own userData (single-instance lock, renderer storage) and its own
 * data root. Without this the two sides would share a lock and, worse, one
 * host-core would write the database the other is reading.
 *
 * Kept separate from `isDevelopmentBuild` because that flag also enables
 * development-only affordances a beta build should not inherit.
 */
export const usesIsolatedProfile =
  isDevelopmentBuild || currentBuildChannel() === "dev";
app.setName(APP_NAME);
applyDevelopmentUserData(app, usesIsolatedProfile);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
export const singleInstanceRequired = !process.env.PI_DESKTOP_DATA_DIR;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(usesIsolatedProfile);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
