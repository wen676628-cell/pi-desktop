/**
 * Facts that turn a silent tool result into an answer.
 *
 * A successful command with no output is indistinguishable from a broken call
 * when the model only sees an empty string, so it runs the same search again.
 * Saying what the emptiness means ends that loop without claiming anything the
 * host did not observe: the note states that the command succeeded and printed
 * nothing, and that an unchanged re-run prints nothing again.
 */
export function successfulSilentBashNote(): string {
  return "The command exited successfully and printed nothing. An unchanged re-run will print nothing again.";
}

/** True for a Bash result that succeeded and produced no visible text. */
export function isEmptySuccessfulBash(toolName: string, text: string, result: unknown): boolean {
  if (toolName !== "Bash" || text.trim() !== "") return false;
  if (typeof result !== "object" || result === null) return false;
  const fields = result as { ok?: unknown; isError?: unknown };
  return fields.ok !== false && fields.isError !== true;
}
