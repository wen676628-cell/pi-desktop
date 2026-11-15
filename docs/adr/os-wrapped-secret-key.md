# ADR: OS-wrapped provider-secret key

## Status

Accepted

## Context

Host-core encrypts provider credentials with AES-256-GCM under a raw 32-byte
key in `secrets/.machine-key`. The ciphertext and the key live under the same
application directory, so copying or backing up the whole profile also copies
the material that decrypts every provider key. The security specification
requires an OS-backed primary store with an explicit fallback, but the host
process cannot call Electron's `safeStorage` itself.

## Decision

Electron main owns the OS wrapping and host-core keeps the store:

1. On startup, before spawning host-core, Electron resolves the store key:
   - `secrets/.safe-key` exists → decrypt it with `safeStorage.decryptString`.
   - Only the legacy `secrets/.machine-key` exists → read it, encrypt it with
     `safeStorage.encryptString`, write `.safe-key` (owner-only), and rename the
     legacy file to `.machine-key.migrated`.
   - Neither exists → generate 32 random bytes and wrap them the same way.
   - `safeStorage` unavailable → pass the legacy key through unchanged; if no
     legacy key exists, pass nothing and host-core creates its own fallback.
2. Electron passes the unwrapped key and backend name to host-core as
   `PI_DESKTOP_SECRET_KEY_B64` / `PI_DESKTOP_SECRET_BACKEND`.
3. Host-core prefers the environment key (backend `safeStorage`) and reports
   that backend through `secrets.status` and `secrets.set`. Without the
   environment key it uses the legacy machine-key path and reports
   `file_fallback`.
4. The model configuration page shows a warning when the live backend is
   `file_fallback`.

The encryption format (nonce ‖ ciphertext ‖ tag, base64, filename
`sha256(secretRef)`) is unchanged, so migration does not re-encrypt existing
secrets.

## Consequences

- On macOS/Windows, a copied profile no longer contains the key that decrypts
  provider credentials; the OS user/keychain binding must also be present.
- Linux depends on the desktop secret-service being available. When it is not,
  the host falls back to the machine-key file and the settings warning is
  visible.
- If the OS key is lost or `.safe-key` cannot be decrypted, previously stored
  secrets are unreadable and must be re-entered; the host does not silently
  generate a replacement key over them.
- The unwrapped key exists in the host child's environment for that launch.
  Another process running as the same OS user can read its own child
  environment, but cannot read another user's; this is the same trust boundary
  that already protects the host's in-memory secrets.
- The renderer never receives raw secrets; it only reads the backend name for
  the warning.
