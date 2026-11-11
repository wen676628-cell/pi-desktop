import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/*
 * Mode switching moved into the composer's built-in slash commands. The
 * toolbar no longer carries an agent-mode chip: `/agent-mode`, `/plan-mode`
 * and `/goal-mode` are the single entry point, and the plus button opens the
 * same list. This keeps the toolbar from advertising two duplicate doors to
 * the same state.
 */

const [builtins, toolbar] = await Promise.all([
  read("../electron/main/builtin-commands.ts"),
  read("../src/features/chat/composer/ComposerToolbar.tsx"),
]);

test("built-in commands carry one slash alias per operating mode", () => {
  assert.match(builtins, /slash: "agent-mode"/);
  assert.match(builtins, /slash: "plan-mode"/);
  assert.match(builtins, /slash: "goal-mode"/);
  assert.match(builtins, /title: "Switch to Agent mode"/);
  assert.match(builtins, /title: "Switch to Plan mode"/);
  assert.match(builtins, /title: "Switch to Goal mode"/);
});

test("the toolbar no longer renders a mode chip", () => {
  assert.doesNotMatch(toolbar, /ComposerModePicker/);
  assert.doesNotMatch(toolbar, /composer-mode-chip/);
  assert.doesNotMatch(toolbar, /settings\.mode/);
});

test("the mode picker is not mounted by the toolbar", async () => {
  const picker = await read("../src/features/chat/composer/ComposerModePicker.tsx");
  assert.match(picker, /export function ComposerModePicker/);
  assert.doesNotMatch(toolbar, /<ComposerModePicker/);
});

test("the plus menu lists the slash commands", async () => {
  const menu = await read("../src/features/chat/composer/ComposerPlusMenu.tsx");
  assert.match(toolbar, /<ComposerPlusMenu/);
  assert.match(menu, /command\.kind === "builtin"/);
  assert.match(menu, /onPickCommand\(command\.name\)/);
  assert.match(menu, /t\("chat\.addFiles"\)/);
});
