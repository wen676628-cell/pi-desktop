import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);

/** The publish job's step list, so assertions cannot match another job. */
const publishJob = workflow.slice(workflow.indexOf("name: Publish GitHub Release"));

const stepBlock = (name) =>
  publishJob.match(new RegExp(`- name: ${name}[^]*?(?=\\n      - name:)`))?.[0] ?? "";

test("the release writes UNOFFICIAL-FORK.txt for forks but never for upstream", () => {
  const block = stepBlock("Write unofficial-fork notice");
  assert.ok(block, "the fork-notice step is missing from the publish job");

  // Fork-only: upstream is the official build and must not claim a fork notice.
  assert.match(block, /if: github\.repository != 'vastsa\/PI-Desktop'/);

  // The asset must land in dist/ because the release uploads `dist/*`.
  assert.match(block, /working-directory: dist/);
  assert.match(block, /cat > UNOFFICIAL-FORK\.txt/);

  // The source link must come from the workflow context, not a hard-coded
  // version: the hand-copied v0.22.0 asset still pointed at v0.21.0.
  assert.match(block, /\$\{GITHUB_REF_NAME\}/);
  assert.doesNotMatch(block, /tree\/v\d+\.\d+\.\d+/);
  assert.doesNotMatch(block, /Source for this tag:\s*\n\s*https:/);
});

test("the fork notice precedes the release upload", () => {
  const noticeIndex = publishJob.indexOf("Write unofficial-fork notice");
  const uploadIndex = publishJob.indexOf("Create GitHub Release");
  assert.ok(noticeIndex > 0 && uploadIndex > 0);
  assert.ok(
    noticeIndex < uploadIndex,
    "the notice must be written before the release uploads dist/*",
  );
});
