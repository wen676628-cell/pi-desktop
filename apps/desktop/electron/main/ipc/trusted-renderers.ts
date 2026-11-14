import type { WebContents } from "electron";

/**
 * The renderer surfaces allowed to call the general IPC bridge.
 *
 * Only first-party windows that load `preload/index.cjs` may join: the main
 * window, the live-voice widget, and the plugin launcher. Plugin panels and
 * docked views use the narrow `plugin-panel.js` bridge, external Browser
 * surfaces carry no bridge at all, and nothing else can call `ipcRenderer.
 * invoke` with a whitelisted channel — so the main-process side can reject
 * every sender that never registered here without breaking a first-party
 * surface.
 *
 * This is defense in depth on top of the preload allowlist: a future window
 * that accidentally ships the general preload still cannot reach handlers
 * until it registers, and a compromise of one trusted surface is not
 * silently extended by an unregistered one.
 */
const trusted = new Set<WebContents>();

export function registerTrustedRenderer(contents: WebContents): void {
  trusted.add(contents);
  contents.once("destroyed", () => {
    trusted.delete(contents);
  });
}

export function unregisterTrustedRenderer(contents: WebContents): void {
  trusted.delete(contents);
}

export function isTrustedRenderer(contents: WebContents | undefined | null): boolean {
  return contents !== undefined && contents !== null && trusted.has(contents);
}
