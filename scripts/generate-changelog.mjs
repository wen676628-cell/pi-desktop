#!/usr/bin/env node
/**
 * Generate the repository-root CHANGELOG.md from the shipped in-app catalog.
 *
 * The catalog in packages/shared/src/changelog-*.ts is the single source of
 * truth: the app renders it in Settings → Info, and this script renders the
 * same entries as Markdown so a visitor on GitHub sees the same releases.
 * Run it after every release bump; the generated file is committed.
 *
 * Usage: node scripts/generate-changelog.mjs [--check]
 *   --check  exit 1 if CHANGELOG.md is missing or out of date (release preflight)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const target = path.join(root, "CHANGELOG.md");
const tempDir = path.join(root, ".release-changelog-gen");

const require = createRequire(path.join(root, "packages/shared/package.json"));
const typescript = require("typescript");

const changelogDir = path.join(root, "packages/shared/src");
const sources = readdirSync(changelogDir)
  .filter((name) => /^changelog(-[A-Za-z-]+)?\.ts$/.test(name))
  .sort();

try {
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(path.join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");
  for (const name of sources) {
    const output = typescript.transpileModule(
      readFileSync(path.join(changelogDir, name), "utf8"),
      {
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ES2022,
        },
        fileName: name,
      },
    ).outputText;
    writeFileSync(path.join(tempDir, name.replace(/\.ts$/, ".js")), output, "utf8");
  }
  const { CHANGELOG } = await import(pathToFileURL(path.join(tempDir, "changelog.js")).href);

  const repo = "wen676628-cell/pi-desktop";
  const lines = [
    "# Changelog",
    "",
    "All notable releases of this fork. Generated from the shipped in-app",
    "catalog — run `node scripts/generate-changelog.mjs` after every release",
    "bump instead of editing this file by hand.",
    "",
    "This fork tracks [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop);",
    "the entries below describe what this fork ships, including fork-specific",
    "fixes on top of the synced upstream line.",
    "",
  ];
  for (const entry of CHANGELOG.en) {
    const tag = `v${entry.version}`;
    lines.push(`## [${tag}] - ${entry.date}`);
    lines.push("");
    lines.push(`[Release page](https://github.com/${repo}/releases/tag/${tag})`);
    lines.push("");
    for (const highlight of entry.highlights) {
      lines.push(`- ${highlight}`);
    }
    lines.push("");
  }
  lines.push(`[Unreleased]: https://github.com/${repo}/compare/${CHANGELOG.en[0].version}...main`);
  lines.push("");

  const markdown = lines.join("\n") + "\n";

  if (check) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== markdown) {
      console.error("CHANGELOG.md is missing or out of date with the shipped catalog.");
      console.error("Run: node scripts/generate-changelog.mjs");
      process.exit(1);
    }
    console.log("CHANGELOG.md is up to date with the shipped catalog.");
  } else {
    writeFileSync(target, markdown, "utf8");
    console.log(`Generated CHANGELOG.md with ${CHANGELOG.en.length} releases.`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
