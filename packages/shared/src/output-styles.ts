/**
 * Output styles: how the agent writes to the user, chosen per installation.
 *
 * One definition for the settings union, the guard, and the settings UI; the
 * instruction text each style contributes lives in the agent runtime, where the
 * prompt is composed. `default` means "no style block": the base prompt's own
 * rules and nothing more.
 */
export type OutputStyleId = "default" | "concise" | "explanatory" | "mentor";

export const OUTPUT_STYLE_IDS = ["default", "concise", "explanatory", "mentor"] as const;

export function isOutputStyleId(value: unknown): value is OutputStyleId {
  return typeof value === "string" && (OUTPUT_STYLE_IDS as readonly string[]).includes(value);
}
