/**
 * Guard for a build landmine in electron-vite's `vite:esm-shim` plugin.
 *
 * That plugin appends its CJS shim after the "last static import" it finds with
 * a regex, and the regex does not know about string literals: a catalog value
 * that ends with the bare word `import` before a closing quote (English "Export
 * and import") looks like `import"…"` and the shim is spliced into the string.
 * esbuild then fails the main build with "Unterminated string literal".
 *
 * The wording is fixed; this test keeps it fixed. Any locale may still say
 * "import" — only the sequence `import` immediately followed by a quote is
 * hazardous, so that is what we reject.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const localesRoot = join(repoRoot, "packages/i18n/src/locales");

const localeDirs = readdirSync(localesRoot).filter((name) => {
  try {
    return statSync(join(localesRoot, name, "index.ts")).isFile();
  } catch {
    return false;
  }
});

test("the locale set is discoverable", () => {
  assert.ok(localeDirs.length >= 9, `expected at least 9 locales, found ${localeDirs.length}`);
});

test("no catalog string ends with a bare `import` before a quote", () => {
  const offenders = [];
  for (const locale of localeDirs) {
    const source = readFileSync(join(localesRoot, locale, "index.ts"), "utf8");
    // `import"` / `import'` inside a value is what the shim regex mistakes for
    // a static import; a value like "Import…" (capitalized) is fine.
    for (const match of source.matchAll(/\bimport(["'])/g)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${locale}:${line}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a locale value ends a word with `import` before a quote; reword it or the main bundle will not build",
  );
});
