/**
 * Output styles (ADR output-style-selection).
 *
 * `default` adds nothing; the other three add the block the settings UI names,
 * and the block must survive a custom persona because it is the user's own
 * choice, not the product's voice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OUTPUT_STYLE_IDS, isOutputStyleId } from "../../../packages/shared/src/output-styles.ts";
import { outputStylePrompt } from "../../../packages/agent-runtime/src/output-styles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

test("only the four documented styles are accepted", () => {
  assert.deepEqual([...OUTPUT_STYLE_IDS], ["default", "concise", "explanatory", "mentor"]);
  for (const id of OUTPUT_STYLE_IDS) assert.equal(isOutputStyleId(id), true, id);
  for (const value of ["", "Concise", "verbose", null, 1, undefined, {}]) {
    assert.equal(isOutputStyleId(value), false, String(value));
  }
});

test("default and unknown ids contribute no prompt block", () => {
  assert.equal(outputStylePrompt("default"), null);
  assert.equal(outputStylePrompt(undefined), null);
  assert.equal(outputStylePrompt(null), null);
  // A stored id from a newer build must not invent text.
  assert.equal(outputStylePrompt("verbose"), null);
});

test("each style carries its own contract", () => {
  const concise = outputStylePrompt("concise");
  assert.match(concise, /No preamble, no restating the request, no summary of what you just did/);
  const explanatory = outputStylePrompt("explanatory");
  assert.match(explanatory, /## Insight/);
  const mentor = outputStylePrompt("mentor");
  assert.match(mentor, /leave the decision to the user/);
  // Distinct blocks: selecting one must not also select another.
  assert.notEqual(concise, explanatory);
  assert.notEqual(explanatory, mentor);
});

test("the runtime composes the chosen style into the operational block", () => {
  const runtime = read("packages/agent-runtime/src/runtime.ts");
  assert.match(runtime, /outputStylePrompt\(this\.outputStyle\)/);
  assert.match(runtime, /private readonly outputStyle: OutputStyleId \| undefined/);
  // The style sits after the persona and before task routing, so replacing the
  // persona leaves the user's chosen style in place.
  const persona = runtime.indexOf("DEFAULT_RUNTIME_SYSTEM_PROMPT,");
  const style = runtime.indexOf("...(outputStylePrompt(this.outputStyle)");
  const routing = runtime.indexOf("Task types: serve the request as what it is");
  assert.ok(persona > 0 && style > persona && routing > style);

  const sidecar = read("packages/agent-runtime/src/sidecar.ts");
  assert.match(sidecar, /isOutputStyleId\(params\.outputStyle\)/);
  const launcher = read("apps/desktop/electron/main/runtime/session-launch.ts");
  assert.match(launcher, /settings\.outputStyle/);
});

test("both settings validators reject an unknown style", () => {
  for (const path of [
    "apps/desktop/src/lib/api.ts",
    "apps/desktop/electron/main/runtime/provider-catalog.ts",
  ]) {
    const source = read(path);
    // `undefined` counts as absent: a read-modify-write round trip must not
    // fail validation just because normalize omitted the key.
    assert.match(source, /\.outputStyle !== undefined/, path);
    assert.match(source, /isOutputStyleId/, path);
    assert.match(source, /outputStyle is invalid/, path);
  }
});

test("the settings page offers exactly the four styles", () => {
  const page = read("apps/desktop/src/features/settings/pages/AgentBehaviorSettings.tsx");
  for (const id of OUTPUT_STYLE_IDS) {
    assert.ok(page.includes(`{ id: "${id}"`), `missing ${id} option`);
  }
  // One selector, so the stored value can only be one of them.
  assert.match(page, /saveSettings\(\{ outputStyle: style as OutputStyleId \}\)/);
});
