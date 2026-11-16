#!/usr/bin/env node
/**
 * Generate the repository-root CHANGELOG.md / CHANGELOG.zh-CN.md from the
 * shipped in-app catalog.
 *
 * The catalog in packages/shared/src/changelog-*.ts is the single source of
 * truth: the app renders it in Settings → Info, and this script renders the
 * same entries as Markdown so a visitor on GitHub sees the same releases —
 * in English and Simplified Chinese, like PiDeck's bilingual changelog.
 * Run it after every release bump; the generated files are committed.
 *
 * Usage: node scripts/generate-changelog.mjs [--check]
 *   --check  exit 1 if a generated file is missing or out of date (release preflight)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const tempDir = path.join(root, ".release-changelog-gen");

const require = createRequire(path.join(root, "packages/shared/package.json"));
const typescript = require("typescript");

const changelogDir = path.join(root, "packages/shared/src");
const sources = readdirSync(changelogDir)
  .filter((name) => /^changelog(-[A-Za-z-]+)?\.ts$/.test(name))
  .sort();

// Generated outputs: locale key → file name + header language.
const OUTPUTS = [
  { locale: "en", file: "CHANGELOG.md", title: "# Changelog" },
  {
    locale: "zh-CN",
    file: "CHANGELOG.zh-CN.md",
    title: "# 更新日志",
  },
];

const HEADERS = {
  en: {
    intro: [
      "All notable releases of this fork. Generated from the shipped in-app",
      "catalog — run `node scripts/generate-changelog.mjs` after every release",
      "bump instead of editing this file by hand.",
      "",
      "This fork tracks [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop);",
      "the entries below describe what this fork ships, including fork-specific",
      "fixes on top of the synced upstream line.",
      "",
    ],
    releasePage: "Release page",
  },
  "zh-CN": {
    intro: [
      "本 fork 的全部重要发布。由应用内更新目录生成——每次版本升级后运行",
      "`node scripts/generate-changelog.mjs` 重新生成，请勿手动编辑本文件。",
      "",
      "本 fork 跟踪 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)；",
      "以下条目描述本 fork 实际发布的变更，包含在同步的上游基线之上的",
      "fork 专属修复。",
      "",
    ],
    releasePage: "发布页",
  },
};

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
  const generated = [];
  for (const { locale, file, title } of OUTPUTS) {
    const catalog = CHANGELOG[locale];
    if (!catalog?.length) throw new Error(`changelog catalog missing locale ${locale}`);
    const header = HEADERS[locale];
    const lines = [title, "", ...header.intro];
    for (const entry of catalog) {
      const tag = `v${entry.version}`;
      lines.push(`## [${tag}] - ${entry.date}`);
      lines.push("");
      lines.push(`[${header.releasePage}](https://github.com/${repo}/releases/tag/${tag})`);
      lines.push("");
      for (const highlight of entry.highlights) {
        lines.push(`- ${highlight}`);
      }
      lines.push("");
    }
    lines.push(
      `[Unreleased]: https://github.com/${repo}/compare/${catalog[0].version}...main`,
    );
    lines.push("");
    generated.push({ file, markdown: lines.join("\n") + "\n" });
  }

  for (const { file, markdown } of generated) {
    const target = path.join(root, file);
    if (check) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : "";
      if (current !== markdown) {
        console.error(`${file} is missing or out of date with the shipped catalog.`);
        console.error("Run: node scripts/generate-changelog.mjs");
        process.exit(1);
      }
    } else {
      writeFileSync(target, markdown, "utf8");
      const releases = CHANGELOG[OUTPUTS.find((o) => o.file === file).locale].length;
      console.log(`Generated ${file} with ${releases} releases.`);
    }
  }
  if (check) {
    console.log("Generated changelog files are up to date with the shipped catalog.");
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
