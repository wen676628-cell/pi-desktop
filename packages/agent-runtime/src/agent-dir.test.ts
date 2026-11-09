import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentDir, resolveAgentPath } from "./agent-dir.js";

// `resolveAgentDir` normalizes through `node:path`, which only treats a path as
// absolute when it is absolute on the platform running the test. Fixtures stay
// platform-native so the suite proves the invariant on every CI runner instead
// of pinning it to whatever `resolve` does with the other platform's syntax.
const isWindows = process.platform === "win32";
const configuredDir = isWindows ? "D:\\omp\\home\\agent" : "/omp/home/agent";
const userHome = isWindows ? "C:\\Users\\me" : "/home/me";
const fallbackDir = resolve(join(userHome, ".pi", "agent"));

describe("resolveAgentDir", () => {
  it("uses PI_CODING_AGENT_DIR when the pi CLI set one", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: configuredDir }, userHome)).toBe(configuredDir);
  });

  it("falls back to ~/.pi/agent so Desktop and an unset CLI still agree", () => {
    expect(resolveAgentDir({}, userHome)).toBe(fallbackDir);
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "   " }, userHome)).toBe(fallbackDir);
  });

  it("resolves subpaths inside the shared directory", () => {
    expect(resolveAgentPath("sessions")).toBe(join(resolveAgentDir(), "sessions"));
  });

  it("defaults to the real home when called without arguments", () => {
    expect(resolveAgentDir()).toBe(
      process.env.PI_CODING_AGENT_DIR?.trim()
        ? resolveAgentDir(process.env)
        : join(homedir(), ".pi", "agent"),
    );
  });
});
