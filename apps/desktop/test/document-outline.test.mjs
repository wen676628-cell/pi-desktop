/**
 * Document outline for the writing surface (ADR writing-surface).
 *
 * The rail is only useful if it agrees with what the reader sees: frontmatter is
 * not a heading, a `#` inside a fenced snippet is not a heading, and a section
 * owns only the text under it, not the next heading's body.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  countWords,
  parseDocumentOutline,
  sectionText,
} from "../src/lib/document-outline.ts";

const article = `---
title: Release notes
tags: [draft]
---

# Why this release

A short opening paragraph with five words.

## What changed

- one
- two

### Details

Nested body text.

## What did not

Nothing here.

\`\`\`sh
# this fence line is not a heading
echo hi
\`\`\`

# 中文部分

这是一段中文。
`;

test("frontmatter and fenced code never become headings", () => {
  const outline = parseDocumentOutline(article);
  assert.deepEqual(
    outline.headings.map((heading) => `${heading.level}:${heading.text}`),
    ["1:Why this release", "2:What changed", "3:Details", "2:What did not", "1:中文部分"],
  );
});

test("a heading reports the line the editor shows", () => {
  const outline = parseDocumentOutline(article);
  // "# Why this release" is line 6 of the file, frontmatter included.
  assert.equal(outline.headings[0].line, 6);
});

test("a section owns only its own body", () => {
  const outline = parseDocumentOutline(article);
  const changes = outline.headings.find((heading) => heading.text === "What changed");
  assert.match(changes.body, /- one/);
  assert.doesNotMatch(changes.body, /Nested body text/, "a nested heading's body is not the parent's");
  assert.doesNotMatch(changes.body, /Nothing here/);
});

test("word counting treats CJK per character and Latin per run", () => {
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("don't stop"), 2);
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("hello 世界"), 3);
  assert.equal(countWords(""), 0);
});

test("document stats ignore the frontmatter block", () => {
  const outline = parseDocumentOutline(article);
  assert.ok(outline.stats.words > 0);
  assert.equal(outline.stats.headings, 5);
  assert.equal(outline.stats.readingMinutes >= 1, true);
  assert.equal(outline.stats.characters > 0, true);
  // The frontmatter text ("Release notes", "draft") is metadata, not prose.
  assert.equal(countWords(article) > outline.stats.words, true);
});

test("an empty or heading-less document says so instead of inventing rows", () => {
  assert.deepEqual(parseDocumentOutline("").headings, []);
  assert.deepEqual(parseDocumentOutline("just a paragraph\n\nand more").headings, []);
  assert.equal(parseDocumentOutline("").stats.readingMinutes, 0);
});

test("a copied section is the heading plus its own body", () => {
  const outline = parseDocumentOutline(article);
  const details = outline.headings.find((heading) => heading.text === "Details");
  assert.equal(sectionText(article, details), "### Details\n\nNested body text.");
  const empty = parseDocumentOutline("# Only a title\n").headings[0];
  assert.equal(sectionText("# Only a title\n", empty), "# Only a title");
});

test("deeper headings keep their level even beyond the rail's indentation cap", () => {
  const outline = parseDocumentOutline("# a\n\n###### deep\n\nbody\n");
  assert.deepEqual(outline.headings.map((heading) => heading.level), [1, 6]);
  // Ids stay unique per line, so two same-text headings cannot collide.
  assert.equal(new Set(outline.headings.map((heading) => heading.id)).size, 2);
});

test("the Files preview wires the rail for Markdown documents", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const tab = readFileSync(join(repoRoot, "apps/desktop/src/components/workpanel/FilesTab.tsx"), "utf8");

  // The toggle exists and is offered only for a Markdown preview, not for code,
  // images or a line-pinned view.
  assert.match(tab, /file\?\.kind === "text" && isMarkdownPath\(selected\) && selectedLine === undefined/);
  assert.match(tab, /setShowOutline\(\(value\) => !value\)/);
  assert.match(tab, /<DocumentOutline markdown=\{file\.content \?\? ""\} \/>/);
  // Outline and preview share the document layout, and switching files closes
  // the rail so the next preview is not silently narrowed.
  assert.match(tab, /file-viewer-document/);
  assert.match(tab, /setShowOutline\(false\)/);

  const css = readFileSync(join(repoRoot, "apps/desktop/src/styles/work-panel.css"), "utf8");
  assert.match(css, /\.document-outline \{/);
  assert.match(css, /\.file-viewer-document\.has-outline/);
});
