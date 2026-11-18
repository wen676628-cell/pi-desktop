/**
 * Refuse a third byte-identical inspection call inside one turn.
 *
 * Real sessions show the failure this exists for: a run of ten `Read` calls in
 * a row, or `Read → Edit fails → Read → Edit fails` for thirty turns while the
 * answer was already in context. The tool result does not change between those
 * calls, so the model is not learning anything — it is circling.
 *
 * Scope is deliberate:
 *
 *   - Only inspection tools (`Read`, `Grep`, `Glob`). Repeating a mutating tool
 *     or a shell command can be legitimate (run tests after an edit), and
 *     blocking those would break real work.
 *   - Identical arguments only. A different `offset`, pattern or path is a new
 *     call.
 *   - Any mutating tool invalidates the counter, so re-reading a file after
 *     editing it starts a fresh budget. Without that, the guard would punish
 *     exactly the sequence it is supposed to allow.
 *
 * The refusal is model-facing: it says what already happened and what to do
 * instead, so the next turn changes approach instead of retrying.
 */

/** Tools whose repeated identical call is pure redundancy. */
export const REPEAT_GUARDED_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Tools that change workspace state and therefore invalidate re-reads. */
const INVALIDATING_TOOLS = new Set(["Write", "Edit", "Bash"]);

/** Identical calls allowed before the guard refuses: the first two. */
export const IDENTICAL_CALL_LIMIT = 2;

const MAX_ARGS_KEY_LENGTH = 4_096;

/** Stable across key order and whitespace so an equivalent call compares equal. */
export function stableArgsKey(params: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[cycle]";
      seen.add(value as object);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = normalize((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  let text: string;
  try {
    text = JSON.stringify(normalize(params)) ?? "";
  } catch {
    text = String(params);
  }
  return text.length > MAX_ARGS_KEY_LENGTH ? text.slice(0, MAX_ARGS_KEY_LENGTH) : text;
}

export type RepeatCheck =
  | { allowed: true }
  | { allowed: false; occurrence: number; limit: number };

export type ToolRepeatGuard = {
  /** Whether this call may run; a mutating tool resets the counters first. */
  check: (name: string, params: unknown) => RepeatCheck;
  /** A new user turn starts with a clean budget. */
  reset: () => void;
};

export function createToolRepeatGuard(
  limit: number = IDENTICAL_CALL_LIMIT,
): ToolRepeatGuard {
  let generation = 0;
  let counts = new Map<string, number>();
  return {
    check(name, params) {
      if (INVALIDATING_TOOLS.has(name)) {
        generation += 1;
        counts = new Map();
        return { allowed: true };
      }
      if (!(REPEAT_GUARDED_TOOLS as readonly string[]).includes(name)) {
        return { allowed: true };
      }
      const key = `${name}\u0000${generation}\u0000${stableArgsKey(params)}`;
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      return occurrence > limit ? { allowed: false, occurrence, limit } : { allowed: true };
    },
    reset() {
      generation += 1;
      counts = new Map();
    },
  };
}

/** The model-facing refusal, phrased so the next step changes rather than retries. */
export function repeatRefusalMessage(name: string, limit: number): string {
  return (
    `Refused: this exact \`${name}\` call has already run ${limit} times in this turn, and its result is ` +
    `already in your context. Nothing has changed since. Do not repeat it: change the arguments, take a ` +
    `different approach, answer with what you have, or say what is blocking you.`
  );
}
