/**
 * The instruction text each output style contributes to the composed prompt.
 *
 * Adapted from Reasonix Studio's `internal/runtime/outputstyle`: the style is a
 * block appended to the system prompt, separate from the persona, so a user can
 * change how the agent writes without editing `SYSTEM.md`. `default` adds
 * nothing.
 */
import type { OutputStyleId } from "@pi-desktop/shared";

const STYLE_PROMPTS: Record<Exclude<OutputStyleId, "default">, string> = {
  concise:
    "Communication style — Concise: keep replies terse. No preamble, no restating the request, no summary of what you just did. Prefer short paragraphs and bullets over essays, and use the fewest words that stay unambiguous.",
  explanatory:
    "Communication style — Explanatory: surface the reasoning behind non-obvious choices as you work. After a substantive step, add a short `## Insight` note naming the trade-off you accepted or the alternative you rejected. Teach the why, briefly.",
  mentor:
    "Communication style — Mentor: explain the reasoning and the trade-offs as you go, recommend one path, then leave the decision to the user. Do not take over choices that are theirs to make.",
};

/** The style block for a stored setting; `null` means "no block". */
export function outputStylePrompt(style: OutputStyleId | undefined | null): string | null {
  if (!style || style === "default") return null;
  return STYLE_PROMPTS[style] ?? null;
}
