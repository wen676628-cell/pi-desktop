/**
 * RPC module budget (ADR rpc-module-decomposition, policy item 5).
 *
 * `crates/host-core/src/rpc/mod.rs` is the host's dispatch table and the
 * repository's largest conflict surface. The ADR keeps the table and moves
 * handler bodies into domain modules; this test is the ratchet that stops the
 * file from growing again while that happens.
 *
 * The budget is a tripwire with headroom, not a target. Lower it only after an
 * extraction lands; never raise it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RPC_MOD = join(repoRoot, "crates/host-core/src/rpc/mod.rs");
const BUDGET = 12_500;

test("rpc/mod.rs stays inside the decomposition budget", () => {
  const source = readFileSync(RPC_MOD, "utf8");
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  assert.ok(
    lines <= BUDGET,
    `crates/host-core/src/rpc/mod.rs is ${lines} lines, over the ${BUDGET}-line budget ` +
      "(ADR rpc-module-decomposition). Extract the domain you are touching into rpc/<domain>.rs " +
      "and leave only its dispatch arm here; do not raise the budget.",
  );
  // The ADR expects the file to keep a dispatch table, not to become a stub by
  // accident: if the arms vanish, the wiring moved somewhere unexplained.
  const arms = [...source.matchAll(/^\s+"[a-zA-Z0-9._]+"\s*=>/gm)].length;
  assert.ok(arms >= 150, `expected the dispatch table to stay in mod.rs, found ${arms} arms`);
});
