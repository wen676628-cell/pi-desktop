import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const [styles, tokens, refresh] = await Promise.all([
  loadStyles(),
  readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/frontend-refresh.css", import.meta.url), "utf8"),
]);
function lastRule(selector, source = styles, first = false) {
  const at = first ? source.indexOf(`${selector} {`) : source.lastIndexOf(`${selector} {`);
  assert.notEqual(at, -1, `${selector} must exist`);
  return source.slice(at, source.indexOf("}", at));
}

test("frontend refresh groups the empty-home hero with its composer", () => {
  assert.match(lastRule(".home-scroll", refresh, true), /flex:\s*0 1 auto;/);
  assert.match(lastRule(".home-scroll", refresh, true), /margin-top:\s*auto;/);
  assert.match(lastRule(".home-composer-wrap", refresh, true), /margin-bottom:\s*auto;/);
  assert.match(lastRule(".home-stack-inner", refresh, true), /padding-bottom:\s*20px;/);
  assert.match(
    refresh,
    /@media \(max-height: 640px\)\s*\{[\s\S]*?\.home-scroll\s*\{\s*margin-top:\s*0;/,
  );
});

test("frontend refresh exposes themed state and keyboard-focus surfaces", () => {
  const dark = tokens.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const light = tokens.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  for (const theme of [dark, light]) {
    assert.match(theme, /--ds-front-accent:/);
    assert.match(theme, /--ds-front-accent-ink:/);
    assert.match(theme, /--ds-front-composer-shadow:/);
  }
  assert.match(lastRule(".thread-item.active"), /background:\s*var\(--ds-front-accent-soft\);/);
  assert.match(lastRule(":root[data-theme] .composer-shell:focus-within"), /border-color:\s*var\(--ds-front-accent\);/);
  assert.match(lastRule(".send-btn:not(:disabled)"), /background:\s*var\(--ds-front-accent\);/);
  assert.match(lastRule(".send-btn:disabled"), /background:\s*var\(--ds-send-disabled-bg\);/);
});
