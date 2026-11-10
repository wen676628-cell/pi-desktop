#!/usr/bin/env node
/**
 * Report configuration that other coding agents already keep on disk.
 *
 *   node scripts/discover-agent-config.mjs [--root <dir>] [--home <dir>] [--json]
 *
 * Read-only: nothing is imported, copied, or rewritten. The same scanner backs
 * the settings surface; this entry point exists so the report is inspectable
 * from a terminal and reusable in support threads.
 */
import { discoverExternalConfig } from "../packages/agent-runtime/src/discover-config.ts";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const workspaceRoot = arg("root", process.cwd());
const home = arg("home", undefined);
const asJson = process.argv.includes("--json");

const found = await discoverExternalConfig({
  workspaceRoot,
  ...(home ? { home } : {}),
});

if (asJson) {
  process.stdout.write(`${JSON.stringify({ workspaceRoot, home: home ?? null, found }, null, 2)}\n`);
} else if (found.length === 0) {
  process.stdout.write("No external agent configuration found.\n");
} else {
  const rows = found.map((entry) => [
    entry.scope,
    entry.provider,
    entry.kind,
    entry.entries === undefined ? "" : String(entry.entries),
    entry.path,
  ]);
  const header = ["scope", "provider", "kind", "count", "path"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  process.stdout.write(`${line(header)}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}
