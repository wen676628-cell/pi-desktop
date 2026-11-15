import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HostSecretKey = {
  key: Buffer;
  backend: "safeStorage" | "file_fallback";
};

/** The subset of Electron safeStorage the key resolver needs. */
export type SecretKeyStorage = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

function osEncryptionAvailable(storage: SecretKeyStorage, platform: string): boolean {
  if (!storage.isEncryptionAvailable()) return false;
  if (platform !== "linux") return true;
  const backend = storage.getSelectedStorageBackend?.();
  return backend !== "basic_text" && backend !== "unknown";
}

/**
 * Resolve the key host-core should use for provider secrets.
 *
 * - OS encryption available: unwrap `.safe-key`, or wrap the legacy
 *   `.machine-key` into it on first launch and move the raw key aside.
 * - OS encryption unavailable: hand the legacy key through unchanged so the
 *   existing secrets still decrypt; the host reports `file_fallback`.
 * - Neither exists: return null and let host-core create its own fallback
 *   file, preserving the released behavior.
 *
 * Keeping this free of Electron imports lets the migration rules run under a
 * plain fake storage in tests; `secret-key.ts` supplies the real one.
 */
export function resolveHostSecretKeyWith(
  dataDir: string,
  storage: SecretKeyStorage,
  platform: string,
): HostSecretKey | null {
  const dir = join(dataDir, "secrets");
  const wrappedPath = join(dir, ".safe-key");
  const legacyPath = join(dir, ".machine-key");

  if (osEncryptionAvailable(storage, platform)) {
    try {
      if (existsSync(wrappedPath)) {
        const key = Buffer.from(
          storage.decryptString(readFileSync(wrappedPath)),
          "base64",
        );
        if (key.length === 32) return { key, backend: "safeStorage" };
      } else {
        const key = existsSync(legacyPath) ? readFileSync(legacyPath) : randomBytes(32);
        if (key.length !== 32) return null;
        mkdirSync(dir, { recursive: true });
        writeFileSync(wrappedPath, storage.encryptString(key.toString("base64")), {
          mode: 0o600,
        });
        if (existsSync(legacyPath)) {
          try {
            renameSync(legacyPath, `${legacyPath}.migrated`);
          } catch {
            // The wrapped key is already durable; a leftover raw file only
            // means the migration is incomplete, not that the key was lost.
          }
        }
        return { key, backend: "safeStorage" };
      }
    } catch {
      // Fall through: OS encryption exists but this profile's key is unusable.
    }
  }

  if (existsSync(legacyPath)) {
    const key = readFileSync(legacyPath);
    if (key.length === 32) return { key, backend: "file_fallback" };
  }
  return null;
}
