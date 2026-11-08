import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The one agent configuration directory shared with the pi CLI.
 *
 * pi CLI resolves this from `PI_CODING_AGENT_DIR`; Desktop must use the same
 * value so sessions, skills, extensions, prompts and AGENTS.md are one set
 * instead of two independent copies. Without the variable we keep pi's own
 * default, `~/.pi/agent`.
 */
export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return resolve(configured && configured.length > 0 ? configured : join(home, ".pi", "agent"));
}

/** A path inside the shared agent directory. */
export function resolveAgentPath(
  ...segments: string[]
): string {
  return resolve(resolveAgentDir(), ...segments);
}
