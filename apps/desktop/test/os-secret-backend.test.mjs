import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostSecretKeyWith } from "../electron/main/secret-key-resolver.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const locale = (name) =>
  read(`../../../packages/i18n/src/locales/${name}/index.ts`);

test("host-core prefers the wrapped key and reports the backend", async () => {
  const secrets = await read("../../../crates/host-core/src/secrets.rs");
  assert.match(secrets, /const ENV_KEY: &str = "PI_DESKTOP_SECRET_KEY_B64"/);
  assert.match(secrets, /const ENV_BACKEND: &str = "PI_DESKTOP_SECRET_BACKEND"/);
  assert.match(secrets, /std::env::var\(ENV_KEY\)/);
  assert.match(secrets, /Ok\(self\.backend\.clone\(\)\)/);
  assert.match(secrets, /pub fn backend\(&self\)/);
  // No env key keeps the released machine-key path.
  assert.match(secrets, /\(key, "file_fallback"\.into\(\)\)/);
  // The env key wins without touching the legacy file.
  assert.match(secrets, /if let Some\(key\) = env_key \{/);
});

test("Electron wraps the key with safeStorage and migrates the raw file", async () => {
  const bridge = await read("../electron/main/secret-key.ts");
  const resolver = await read("../electron/main/secret-key-resolver.ts");
  assert.match(bridge, /safeStorage as unknown as SecretKeyStorage/);
  assert.match(bridge, /resolveHostSecretKeyWith\(/);
  assert.match(resolver, /function osEncryptionAvailable\(storage/);
  assert.match(resolver, /storage\.isEncryptionAvailable\(\)/);
  assert.match(resolver, /getSelectedStorageBackend/);
  assert.match(resolver, /backend !== "basic_text"/);
  assert.match(resolver, /storage\.decryptString\(readFileSync\(wrappedPath\)\)/);
  assert.match(resolver, /\.safe-key/);
  assert.match(resolver, /\.machine-key/);
  assert.match(resolver, /renameSync\(legacyPath, `\$\{legacyPath\}\.migrated`\)/);
  assert.match(resolver, /backend: "file_fallback"/);
  // A profile with no key at all must let host-core create its own fallback.
  assert.match(resolver, /return null;/);
});

test("the host child receives the key and backend as environment", async () => {
  const host = await read("../electron/main/host-process.ts");
  assert.match(host, /import \{ hostSecretKeyEnv \} from "\.\/secret-key"/);
  assert.match(host, /\.\.\.hostSecretKeyEnv\(dataDir\)/);
});

test("the renderer can read the backend and shows the fallback warning", async () => {
  const protocol = await read("../../../packages/shared/src/protocol.ts");
  const api = await read("../src/lib/api.ts");
  const ipc = await read("../electron/main/ipc/provider-ipc.ts");
  const page = await read("../src/components/settings/ModelConfigPage.tsx");
  const warning = await read(
    "../src/components/settings/SecretsBackendWarning.tsx",
  );
  assert.match(protocol, /secretsStatus: "pi-desktop\/secrets\/status"/);
  assert.match(ipc, /IPC\.invoke\.secretsStatus/);
  assert.match(ipc, /host\.call\("secrets\.status", \{\}\)/);
  assert.match(api, /getSecretsBackend: \(\) =>/);
  assert.match(page, /<SecretsBackendWarning \/>/);
  assert.match(warning, /backend !== "file_fallback"/);
  assert.match(warning, /settings\.secretFallback/);
});

test("the fallback warning is translated in every catalog", async () => {
  for (const name of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"]) {
    assert.match(await locale(name), /secretFallback/, name);
  }
});

function fakeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`wrapped:${value}`, "utf8"),
    decryptString: (buffer) =>
      buffer.toString("utf8").replace(/^wrapped:/, ""),
    ...overrides,
  };
}

async function tempProfile() {
  const dir = await mkdtemp(join(tmpdir(), "pi-secret-key-"));
  await mkdir(join(dir, "secrets"), { recursive: true });
  return dir;
}

test("a fresh profile wraps a generated key and reports safeStorage", async () => {
  const dir = await tempProfile();
  const resolved = resolveHostSecretKeyWith(dir, fakeStorage(), "darwin");
  assert.equal(resolved?.backend, "safeStorage");
  assert.equal(resolved?.key.length, 32);
  const wrapped = await readFile(join(dir, "secrets", ".safe-key"));
  assert.match(wrapped.toString("utf8"), /^wrapped:/);
});

test("a legacy machine key is wrapped and moved aside without value loss", async () => {
  const dir = await tempProfile();
  const key = Buffer.alloc(32, 9);
  await writeFile(join(dir, "secrets", ".machine-key"), key);
  const resolved = resolveHostSecretKeyWith(dir, fakeStorage(), "win32");
  assert.equal(resolved?.backend, "safeStorage");
  assert.deepEqual(resolved?.key, key);
  await access(join(dir, "secrets", ".safe-key"));
  await access(join(dir, "secrets", ".machine-key.migrated"));
});

test("unavailable OS storage keeps the legacy fallback readable", async () => {
  const dir = await tempProfile();
  const key = Buffer.alloc(32, 4);
  await writeFile(join(dir, "secrets", ".machine-key"), key);
  const resolved = resolveHostSecretKeyWith(
    dir,
    fakeStorage({ isEncryptionAvailable: () => false }),
    "linux",
  );
  assert.equal(resolved?.backend, "file_fallback");
  assert.deepEqual(resolved?.key, key);
  await assert.rejects(access(join(dir, "secrets", ".safe-key")));
});

test("Linux basic_text is not treated as OS-backed", async () => {
  const dir = await tempProfile();
  const key = Buffer.alloc(32, 5);
  await writeFile(join(dir, "secrets", ".machine-key"), key);
  const resolved = resolveHostSecretKeyWith(
    dir,
    fakeStorage({ getSelectedStorageBackend: () => "basic_text" }),
    "linux",
  );
  assert.equal(resolved?.backend, "file_fallback");
  await assert.rejects(access(join(dir, "secrets", ".safe-key")));
});

test("no key and no OS storage lets host-core create its own fallback", async () => {
  const dir = await tempProfile();
  const resolved = resolveHostSecretKeyWith(
    dir,
    fakeStorage({ isEncryptionAvailable: () => false }),
    "linux",
  );
  assert.equal(resolved, null);
});
