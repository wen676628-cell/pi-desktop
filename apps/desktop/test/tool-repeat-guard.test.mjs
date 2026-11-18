/**
 * Tool repeat guard (see `tool-repeat-guard.ts`).
 *
 * The reported symptom was an article session where the agent kept calling the
 * same tools; real transcripts show ten `Read` calls in a row and Edit/Read
 * cycles whose results never change. These tests pin the exact budget, the
 * scope (inspection only), and the invalidation rule that keeps a re-read after
 * an edit legal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  IDENTICAL_CALL_LIMIT,
  createToolRepeatGuard,
  repeatRefusalMessage,
  stableArgsKey,
} from "../../../packages/agent-runtime/src/tool-repeat-guard.ts";

const readArgs = { path: "/w/article.md" };

test("the first two identical inspection calls run, the third is refused", () => {
  const guard = createToolRepeatGuard();
  assert.equal(guard.check("Read", readArgs).allowed, true);
  assert.equal(guard.check("Read", readArgs).allowed, true);
  const third = guard.check("Read", readArgs);
  assert.equal(third.allowed, false);
  assert.equal(third.allowed === false && third.occurrence, IDENTICAL_CALL_LIMIT + 1);
});

test("different arguments are different calls", () => {
  const guard = createToolRepeatGuard();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guard.check("Read", { path: "/w/article.md", offset: i * 100 }).allowed, true);
  }
  // Same path with a different offset never collides with the plain read.
  assert.equal(guard.check("Read", readArgs).allowed, true);
});

test("argument key order does not matter", () => {
  assert.equal(
    stableArgsKey({ path: "/w/a.md", offset: 0 }),
    stableArgsKey({ offset: 0, path: "/w/a.md" }),
  );
  const guard = createToolRepeatGuard();
  guard.check("Grep", { path: "/w", include: "md" });
  guard.check("Grep", { include: "md", path: "/w" });
  assert.equal(guard.check("Grep", { path: "/w", include: "md" }).allowed, false);
});

test("only inspection tools are guarded", () => {
  const guard = createToolRepeatGuard();
  for (const name of ["Write", "Edit", "Bash", "TodoWrite", "Task", "TaskWait"]) {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(guard.check(name, readArgs).allowed, true, name);
    }
  }
});

test("a mutation invalidates the budget, so re-reading after an edit is allowed", () => {
  const guard = createToolRepeatGuard();
  guard.check("Read", readArgs);
  guard.check("Read", readArgs);
  assert.equal(guard.check("Read", readArgs).allowed, false);

  // The file changed; the previous refusal must not carry over.
  guard.check("Edit", { path: "/w/article.md", oldString: "a", newString: "b" });
  assert.equal(guard.check("Read", readArgs).allowed, true);
  assert.equal(guard.check("Read", readArgs).allowed, true);
  assert.equal(guard.check("Read", readArgs).allowed, false);
});

test("a new user turn resets the budget", () => {
  const guard = createToolRepeatGuard();
  guard.check("Read", readArgs);
  guard.check("Read", readArgs);
  assert.equal(guard.check("Read", readArgs).allowed, false);
  guard.reset();
  assert.equal(guard.check("Read", readArgs).allowed, true);
});

test("the refusal tells the model what already happened and what to do", () => {
  const message = repeatRefusalMessage("Read", IDENTICAL_CALL_LIMIT);
  assert.match(message, /already run 2 times in this turn/);
  assert.match(message, /already in your context/);
  assert.match(message, /change the arguments, take a different approach/);
  assert.doesNotMatch(message, /error occurred/i, "it is a correction, not a crash report");
});

test("a cyclic argument object does not throw", () => {
  const params = { path: "/w/a.md" };
  params.self = params;
  const guard = createToolRepeatGuard();
  assert.equal(guard.check("Read", params).allowed, true);
  assert.equal(guard.check("Read", params).allowed, true);
  assert.equal(guard.check("Read", params).allowed, false);
});

test("the runtime guards the host dispatch and resets per turn", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const runtime = readFileSync(
    join(repoRoot, "packages/agent-runtime/src/runtime.ts"),
    "utf8",
  );

  // The refusal happens before any host work, and a refused call never reaches
  // `tools.execute`. Wrapping the tool objects instead would have changed the
  // identity the batching and permission logic keys on.
  const guardAt = runtime.indexOf("const repeat = this.toolRepeatGuard.check(toolName, params)");
  const hostAt = runtime.indexOf('"tools.execute", {', guardAt);
  assert.ok(guardAt > 0, "the guard must run in the tool executor");
  assert.ok(hostAt > guardAt, "the guard must precede the host dispatch");
  assert.match(runtime, /errorCode: "TOOL_REPEAT_REFUSED"/);
  assert.match(runtime, /repeatRefusalMessage\(toolName, repeat\.limit\)/);

  // A new user turn starts with a clean budget.
  const resetAt = runtime.indexOf("this.toolRepeatGuard.reset()");
  const promptAt = runtime.indexOf("private async promptTurn(");
  assert.ok(resetAt > 0 && resetAt < promptAt);
});
