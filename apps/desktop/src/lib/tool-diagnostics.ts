import type { LspDiagnostic } from "./api";

export type ToolWriteDiagnostics = {
  server: string;
  diagnostics: LspDiagnostic[];
};

function isDiagnostic(value: unknown): value is LspDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.line === "number" &&
    typeof record.character === "number" &&
    typeof record.endLine === "number" &&
    typeof record.endCharacter === "number" &&
    typeof record.severity === "number" &&
    typeof record.message === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    // A tool result can arrive as its JSON text; parse only object-shaped text.
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Read the language-server findings that Edit/Write attach to their result.
 *
 * Returns `undefined` unless the payload carries a server name and at least one
 * well-formed diagnostic, so the row renders nothing extra for every other
 * tool and for writes no server claimed.
 */
export function toolWriteDiagnostics(
  payload: unknown,
): ToolWriteDiagnostics | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  if (typeof record.server !== "string" || !Array.isArray(record.diagnostics)) {
    return undefined;
  }
  const diagnostics = record.diagnostics.filter(isDiagnostic);
  if (diagnostics.length === 0) return undefined;
  return { server: record.server, diagnostics };
}
