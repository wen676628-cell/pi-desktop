import type { CommandItem, ComposerCommand } from "@pi-desktop/shared";

/**
 * Single source of truth for first-party commands: the palette search list
 * and the composer "/" menu aliases both derive from it (D123, spec 04 §7).
 */
export type BuiltinCommandDef = CommandItem & {
  /** Composer slash alias, unique across the merged command namespace. */
  slash: string;
  /** Older slash spellings kept so released aliases do not stop working. */
  slashAliases?: readonly string[];
};

export const BUILTIN_COMMANDS: BuiltinCommandDef[] = [
  { id: "builtin.session.new", title: "New task", category: "Session", keywords: ["new", "chat", "task"], source: "builtin", slash: "new" },
  { id: "builtin.agent.compact", title: "Compact conversation context", category: "Session", keywords: ["compact", "context", "tokens"], source: "builtin", slash: "compact" },
  { id: "builtin.mode.agent", title: "Switch to Agent mode", category: "Session", keywords: ["mode", "agent"], source: "builtin", slash: "agent", slashAliases: ["agent-mode"] },
  { id: "builtin.mode.plan", title: "Switch to Plan mode", category: "Session", keywords: ["mode", "plan", "planning"], source: "builtin", slash: "plan", slashAliases: ["plan-mode"] },
  { id: "builtin.mode.goal", title: "Switch to Goal mode", category: "Session", keywords: ["mode", "goal", "objective", "autonomous"], source: "builtin", slash: "goal", slashAliases: ["goal-mode"] },
  { id: "builtin.session.fast", title: "Toggle Fast mode", category: "Session", keywords: ["fast", "speed", "priority", "service tier"], source: "builtin", slash: "fast" },
];

/** Palette-shaped items (no slash field leaks into the palette contract). */
export function builtinPaletteItems(): CommandItem[] {
  return BUILTIN_COMMANDS.map(({ slash: _slash, slashAliases: _aliases, ...item }) => item);
}

/** Composer "/" menu entries for the builtin group, including legacy aliases. */
export function builtinComposerCommands(): ComposerCommand[] {
  return BUILTIN_COMMANDS.flatMap((def) =>
    [def.slash, ...(def.slashAliases ?? [])].map((name) => ({
      name,
      kind: "builtin" as const,
      title: def.title,
      ...(def.category ? { description: def.category } : {}),
      id: def.id,
    })),
  );
}
