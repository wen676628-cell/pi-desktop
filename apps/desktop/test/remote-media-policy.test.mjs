import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  isRemoteMediaUrl,
  remoteMediaNeedsGate,
} from "../src/lib/remote-media-policy.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("only http(s) media is treated as remote", () => {
  for (const source of ["https://example.com/a.png", "http://example.com/a.mp3"]) {
    assert.equal(isRemoteMediaUrl(source), true, source);
  }
  for (const source of [
    "attachments/abc",
    "/tmp/a.png",
    "file:///tmp/a.mp3",
    "data:image/png;base64,AA",
    "javascript:alert(1)",
    "",
  ]) {
    assert.equal(isRemoteMediaUrl(source), false, source);
  }
});

test("the click policy gates remote media until it is revealed", () => {
  const source = "https://example.com/a.png";
  assert.equal(remoteMediaNeedsGate("click", source, false), true);
  assert.equal(remoteMediaNeedsGate(undefined, source, false), true);
  assert.equal(remoteMediaNeedsGate("allow", source, false), false);
  assert.equal(remoteMediaNeedsGate("click", source, true), false);
  assert.equal(remoteMediaNeedsGate("click", "attachments/abc", false), false);
});

test("the markdown renderer gates images, audio, and video before mounting src", async () => {
  const markdown = await read("../src/components/Markdown.tsx");
  assert.match(markdown, /function useRemoteMediaPolicy\(\): "click" \| "allow"/);
  assert.match(markdown, /state\.settings\?\.remoteMedia === "allow" \? "allow" : "click"/);
  assert.match(markdown, /data-remote-media=\{kind\}/);
  // The gate button carries no media element or src of its own.
  const gate = markdown.slice(
    markdown.indexOf("function RemoteMediaGate("),
    markdown.indexOf("/**\n * Local image references"),
  );
  assert.doesNotMatch(gate, /<img|<audio|<video|src=/);
  assert.equal(
    markdown.match(/remoteMediaNeedsGate\(remoteMedia, source, /g)?.length,
    3,
    "image, audio, and video all use the shared gate",
  );
});

test("the setting normalizes to click and rejects unknown writes", async () => {
  const api = await read("../src/lib/api.ts");
  assert.match(api, /function isRemoteMediaPolicyValue/);
  assert.match(api, /remoteMedia: isRemoteMediaPolicyValue\(settings\.remoteMedia\)/);
  assert.match(api, /remoteMedia is invalid/);
  assert.match(api, /: "click"/);
});

test("Conversation settings exposes the remote media row", async () => {
  const page = await read("../src/features/settings/pages/ConversationSettings.tsx");
  const row = await read("../src/components/settings/RemoteMediaRow.tsx");
  assert.match(page, /<RemoteMediaRow settings=\{settings\} saveSettings=\{saveSettings\} \/>/);
  assert.match(row, /settings\.remoteMedia/);
  assert.match(row, /labelKey: "settings\.remoteMediaClick"/);
  assert.match(row, /labelKey: "settings\.remoteMediaAllow"/);
});
