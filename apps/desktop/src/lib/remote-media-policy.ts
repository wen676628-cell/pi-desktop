import type { RemoteMediaPolicy } from "@pi-desktop/shared";

/** Whether a markdown media URL would leave the machine to load. */
export function isRemoteMediaUrl(source: string): boolean {
  return /^https?:/i.test(source);
}

/**
 * Whether remote media must wait for a click before its `src` is mounted.
 *
 * `allow` loads immediately; `click` (the default for absent/unknown stored
 * values) keeps the element unmounted until the user asks, so rendering a
 * reply cannot reveal the user's IP to a host the reply names.
 */
export function remoteMediaNeedsGate(
  policy: RemoteMediaPolicy | undefined,
  source: string,
  revealed: boolean,
): boolean {
  return !revealed && policy !== "allow" && isRemoteMediaUrl(source);
}
