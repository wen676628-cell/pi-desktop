import * as electron from "electron";
import {
  resolveHostSecretKeyWith,
  type HostSecretKey,
  type SecretKeyStorage,
} from "./secret-key-resolver";

export type { HostSecretKey, SecretKeyStorage } from "./secret-key-resolver";

/**
 * Namespace import, not `{ safeStorage }`: Node-based tests load this module
 * with a stub `electron` that has no named exports, and a named import would
 * throw before the resolver could fall back.
 */
const safeStorage = (electron as { safeStorage?: SecretKeyStorage }).safeStorage;

/**
 * Environment contract with host-core. The key is wrapped by Electron's
 * safeStorage (macOS Keychain / Windows DPAPI / Linux secret service); the
 * host only ever sees the unwrapped 32 bytes for this launch.
 */
export const HOST_SECRET_KEY_ENV = "PI_DESKTOP_SECRET_KEY_B64";
export const HOST_SECRET_BACKEND_ENV = "PI_DESKTOP_SECRET_BACKEND";

/** Production resolver using Electron's safeStorage. */
export function resolveHostSecretKey(dataDir: string): HostSecretKey | null {
  if (!safeStorage) return null;
  try {
    return resolveHostSecretKeyWith(dataDir, safeStorage, process.platform);
  } catch {
    // safeStorage can refuse before the app is ready or when the OS backend
    // disappeared; the host then keeps its own fallback path.
    return null;
  }
}

/** Environment variables for a host-core child, or an empty patch. */
export function hostSecretKeyEnv(dataDir: string): Record<string, string> {
  const resolved = resolveHostSecretKey(dataDir);
  if (!resolved) return {};
  return {
    [HOST_SECRET_KEY_ENV]: resolved.key.toString("base64"),
    [HOST_SECRET_BACKEND_ENV]: resolved.backend,
  };
}
