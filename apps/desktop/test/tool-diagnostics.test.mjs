import assert from "node:assert/strict";
import test from "node:test";
import { toolWriteDiagnostics } from "../src/lib/tool-diagnostics.ts";

const diagnostic = {
  line: 1,
  character: 2,
  endLine: 1,
  endCharacter: 3,
  severity: 1,
  message: "Cannot find name 'foo'.",
};

test("reads the server and diagnostics from a write result", () => {
  const found = toolWriteDiagnostics({
    path: "a.ts",
    tag: "ABCD",
    server: "typescript",
    diagnostics: [diagnostic],
  });
  assert.equal(found?.server, "typescript");
  assert.equal(found?.diagnostics.length, 1);
  assert.equal(found?.diagnostics[0]?.message, "Cannot find name 'foo'.");
});

test("ignores results that carry no server or diagnostics", () => {
  assert.equal(toolWriteDiagnostics({ path: "a.ts", tag: "ABCD" }), undefined);
  assert.equal(toolWriteDiagnostics({ server: "typescript" }), undefined);
  assert.equal(toolWriteDiagnostics({ diagnostics: [diagnostic] }), undefined);
  assert.equal(toolWriteDiagnostics(null), undefined);
  assert.equal(toolWriteDiagnostics("text"), undefined);
});

test("reads a JSON-text result as well as a structured one", () => {
  const found = toolWriteDiagnostics(
    JSON.stringify({ server: "rust", diagnostics: [diagnostic] }),
  );
  assert.equal(found?.server, "rust");
  assert.equal(found?.diagnostics.length, 1);
  assert.equal(toolWriteDiagnostics("not json"), undefined);
});

test("drops malformed diagnostics and hides an empty list", () => {
  assert.equal(toolWriteDiagnostics({ server: "ts", diagnostics: [] }), undefined);
  assert.equal(
    toolWriteDiagnostics({ server: "ts", diagnostics: [{ message: "x" }] }),
    undefined,
  );
  const mixed = toolWriteDiagnostics({
    server: "ts",
    diagnostics: [diagnostic, { broken: true }],
  });
  assert.equal(mixed?.diagnostics.length, 1);
});
