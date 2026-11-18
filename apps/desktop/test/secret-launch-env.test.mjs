/**
 * Provider-secret launch key lifecycle (P3 of the 2026-11-17 review).
 *
 * Electron wraps the key with OS storage and hands it to host-core through the
 * environment. That environment is inherited by everything host-core spawns
 * afterwards, so the host must read the key once and then drop it. The Electron
 * side must never place it in its own `process.env` at all — only in the host
 * child's environment.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

const KEY_ENV = "PI_DESKTOP_SECRET_KEY_B64";
const BACKEND_ENV = "PI_DESKTOP_SECRET_BACKEND";

function electronMainSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(repoRoot, "apps/desktop/electron"));
  return files.map((path) => relative(repoRoot, path).replaceAll("\\", "/"));
}

test("the host reads the launch key and then removes it from its environment", () => {
  const secrets = read("crates/host-core/src/secrets.rs");
  assert.match(secrets, /pub fn scrub_launch_env\(\)/);
  // Both variables go, not just the key: the backend label also tells a child
  // which store produced the ciphertext.
  const scrub = secrets.slice(secrets.indexOf("pub fn scrub_launch_env"));
  const scrubBody = scrub.slice(0, scrub.indexOf("\n    }"));
  assert.match(scrubBody, /remove_var\(ENV_KEY\)/);
  assert.match(scrubBody, /remove_var\(ENV_BACKEND\)/);

  const state = read("crates/host-core/src/state.rs");
  const open = state.indexOf("SecretStore::open(data_dir)?");
  const scrubAt = state.indexOf("SecretStore::scrub_launch_env()");
  assert.ok(open > 0, "the host opens the secret store at startup");
  assert.ok(scrubAt > open, "the key is scrubbed right after it is read");
  // Nothing may spawn before the scrub in the same function.
  const between = state.slice(open, scrubAt);
  assert.doesNotMatch(
    between,
    /std::process::Command|tokio::process::Command/,
    "no child process may start between reading the key and removing it",
  );
});

test("Electron never puts the launch key in its own environment", () => {
  const offenders = [];
  for (const file of electronMainSources()) {
    const source = read(file);
    for (const match of source.matchAll(/process\.env\.(?:PI_DESKTOP_SECRET[_A-Z]*|[A-Z_]*SECRET[A-Z_]*)\s*=/g)) {
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the key belongs in the host child's env object only; assigning it to process.env leaks it to every later spawn",
  );
});

test("the key travels only into the host child's environment", () => {
  const hostProcess = read("apps/desktop/electron/main/host-process.ts");
  assert.match(hostProcess, /\.\.\.hostSecretKeyEnv\(dataDir\)/);
  const secretKey = read("apps/desktop/electron/main/secret-key.ts");
  assert.ok(secretKey.includes(KEY_ENV));
  assert.ok(secretKey.includes(BACKEND_ENV));
});
