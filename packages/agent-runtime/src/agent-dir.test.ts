import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentDir, resolveAgentPath } from "./agent-dir.js";

describe("resolveAgentDir", () => {
  it("uses PI_CODING_AGENT_DIR when the pi CLI set one", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "D:\\omp\\home\\agent" }, "C:\\Users\\me")).toBe(
      "D:\\omp\\home\\agent",
    );
  });

  it("falls back to ~/.pi/agent so Desktop and an unset CLI still agree", () => {
    expect(resolveAgentDir({}, "C:\\Users\\me")).toBe(join("C:\\Users\\me", ".pi", "agent"));
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "   " }, "C:\\Users\\me")).toBe(
      join("C:\\Users\\me", ".pi", "agent"),
    );
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
