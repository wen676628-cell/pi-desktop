#!/usr/bin/env node
/**
 * PI-Desktop agent long-term memory server (ADR agent-long-term-memory).
 *
 * A local stdio MCP server exposing long-term memory as tools so any agent
 * backend that supports MCP (pi built-in, ACP `mcpServers`, future adapters)
 * shares one memory store. Markdown files are the truth; a SQLite+FTS5
 * mirror is rebuildable; budget trimming is observable, never silent.
 *
 * Configuration is environment variables only (no credential literals):
 *   AGENT_MEMORY_DIR        — memory root; REFUSES to start without it
 *                             (a guessed default would write into some
 *                             process's cwd, a worse failure mode)
 *   AGENT_MEMORY_CWD        — session cwd, derives the project key
 *   AGENT_MEMORY_SOURCES    — JSON [{backend, db, project?}] session indexes.
 *                             Each entry names a host SQLite file opened
 *                             read-only; the server never guesses paths and
 *                             never writes to a host database.
 *
 * Storage model (ADR §2):
 *   <dir>/MEMORY.md          global facts        (32k chars / 400 entries)
 *   <dir>/USER.md            user profile        (32k / 400)
 *   <dir>/STANDING.md        standing notes      (4k / 40, never injected)
 *   <dir>/failures.md        lessons             (32k / 400, [category] prefix)
 *   <dir>/projects/<key>/MEMORY.md + failures.md
 *   <dir>/devices/<key>/MEMORY.md    device-local, never exported
 *   <dir>/tombstones.json    deleted ids so imports don't revive them
 *   <dir>/agent-memory.db    SQLite+FTS5 mirror (rebuildable, deletable)
 *
 * Entries are plain-text paragraphs separated by `\n§\n`. Atomic writes
 * (temp + rename). Whitespace-folding dedupe. Oldest-first budget trim,
 * reported in results (`trimmed.{count,oldest}`) and status output.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// `node:sqlite` is loaded through require so an older Node degrades to a
// structured "session-index-unavailable" instead of failing at import time.
const require = createRequire(import.meta.url);

const BUDGETS = {
  memory: { file: "MEMORY.md", chars: 32000, entries: 400 },
  user: { file: "USER.md", chars: 32000, entries: 400 },
  failure: { file: "failures.md", chars: 32000, entries: 400 },
  standing: { file: "STANDING.md", chars: 4000, entries: 40 },
  project: { file: "MEMORY.md", chars: 32000, entries: 400 },
};
const STANDING_FAILURES = { file: "failures.md", chars: 4000, entries: 40 };
const ENTRY_SEPARATOR = "\n§\n";
const MAX_ENTRY_CHARS = 2000;
const TOMBSTONE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Environment (fail closed, no guessed paths)
// ---------------------------------------------------------------------------

const memoryDir = process.env.AGENT_MEMORY_DIR?.trim();
if (!memoryDir) {
  console.error("agent-memory: AGENT_MEMORY_DIR is required; refusing to start");
  process.exit(1);
}
const sessionCwd = process.env.AGENT_MEMORY_CWD?.trim() || "";
let collectionSources = [];
try {
  const raw = process.env.AGENT_MEMORY_SOURCES?.trim();
  if (raw) collectionSources = JSON.parse(raw);
} catch {
  console.error("agent-memory: AGENT_MEMORY_SOURCES is not valid JSON; ignoring");
}

/** Session-history search bounds: sessions returned, matches per session, snippet size. */
const SESSION_SEARCH_MAX_SESSIONS = 20;
const SESSION_SEARCH_MESSAGES_PER_HIT = 3;
const SESSION_SEARCH_SNIPPET_CHARS = 400;

// ---------------------------------------------------------------------------
// Paths and project keys
// ---------------------------------------------------------------------------

const fileFor = (target, projectId) => {
  const budget = BUDGETS[target];
  if (!budget) throw new Error(`unknown target: ${target}`);
  if (target === "project") {
    if (!projectId) throw new Error("project target requires a projectId");
    const dir = join(memoryDir, "projects", projectId);
    const name = target === "failure" ? "failures.md" : budget.file;
    return { file: join(dir, name), budget };
  }
  return { file: join(memoryDir, budget.file), budget };
};

const failureFileFor = (projectId) => {
  if (projectId) {
    return {
      file: join(memoryDir, "projects", projectId, STANDING_FAILURES.file),
      budget: STANDING_FAILURES,
    };
  }
  return { file: join(memoryDir, STANDING_FAILURES.file), budget: STANDING_FAILURES };
};

const deviceFile = join(memoryDir, "devices", "local", "MEMORY.md");

/** `<readable prefix 80>-<8-char path hash>` — hash always present. */
export function projectKeyFor(cwd) {
  if (!cwd) return null;
  const normalized = cwd.replace(/[\\/]+$/, "");
  const readable =
    normalized
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 80) || "project";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

// ---------------------------------------------------------------------------
// Entry parsing / serialization (Markdown is the truth)
// ---------------------------------------------------------------------------

export function parseEntries(text) {
  return text
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.replace(/^\s*\n/, "").replace(/\n\s*$/, ""))
    .filter((entry) => entry.trim().length > 0);
}

export function serializeEntries(entries) {
  return entries.join(ENTRY_SEPARATOR) + "\n";
}

/** Whitespace-folding dedupe: same sentence never becomes a second entry. */
const normalizeForDedupe = (entry) => entry.replace(/\s+/g, " ").trim();

const foldTombstoned = (entries, tombstones, fileLabel) =>
  entries.filter(
    (entry) => !tombstones.has(`${fileLabel}:${normalizeForDedupe(entry)}`),
  );

// ---------------------------------------------------------------------------
// Atomic file IO
// ---------------------------------------------------------------------------

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

const readEntries = (file) => {
  try {
    if (!existsSync(file)) return [];
    return parseEntries(readFileSync(file, "utf8"));
  } catch {
    // A torn or unreadable truth file must not take the server down; the
    // entries that failed to parse are gone but writes still work.
    return [];
  }
};

const loadTombstones = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(memoryDir, "tombstones.json"), "utf8"));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
};

const saveTombstones = (tombstones) => {
  const list = [...tombstones].slice(-TOMBSTONE_LIMIT);
  atomicWrite(join(memoryDir, "tombstones.json"), JSON.stringify(list, null, 2));
};

/** Budget trim oldest-first; returns what was dropped so trimming is observable. */
function trimToBudget(entries, budget) {
  const result = { dropped: 0, overCharBudget: false };
  let totalChars = 0;
  for (const entry of entries) totalChars += entry.length;
  while (
    entries.length > budget.entries ||
    totalChars > budget.chars
  ) {
    const dropped = entries.shift();
    if (dropped === undefined) break;
    totalChars -= dropped.length;
    result.dropped += 1;
    if (dropped.length > MAX_ENTRY_CHARS) result.overCharBudget = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools = {
  memory_add(args) {
    const target = args.target;
    if (!BUDGETS[target]) {
      return badRequest(`unknown target: ${target}`);
    }
    if (target === "project" && !args.projectId) {
      return badRequest("project target requires a projectId");
    }
    if (target === "failure" && !args.projectId && args.projectId !== undefined) {
      // global failures are allowed; explicit null projectId is fine
    }
    const entry = String(args.entry ?? "").trim();
    if (!entry) return badRequest("entry is empty");
    if (entry.length > MAX_ENTRY_CHARS) {
      return badRequest(`entry exceeds ${MAX_ENTRY_CHARS} chars`);
    }
    if (target === "failure") {
      const category = String(args.category ?? "").trim();
      if (!category) return badRequest("failure entries require a [category]");
      const prefixed = `[${category}] ${entry}`;
      return addToScope(failureFileFor(args.projectId), prefixed, "failure", args.projectId);
    }
    if (target === "device") {
      return addToScope({ file: deviceFile, budget: BUDGETS.memory }, entry, "device");
    }
    return addToScope(fileFor(target, args.projectId), entry, target, args.projectId);
  },

  memory_replace(args) {
    const target = args.target;
    const filter = normalizeForDedupe(String(args.match ?? ""));
    if (!filter) return badRequest("match is empty");
    const replacement = String(args.entry ?? "").trim();
    if (!replacement) return badRequest("entry is empty");
    if (replacement.length > MAX_ENTRY_CHARS) {
      return badRequest(`entry exceeds ${MAX_ENTRY_CHARS} chars`);
    }
    const { file, budget } =
      target === "failure"
        ? failureFileFor(args.projectId)
        : fileFor(target, args.projectId);
    const entries = readEntries(file);
    const matches = entries.filter(
      (entry) => normalizeForDedupe(entry) === filter ||
        normalizeForDedupe(entry).includes(filter),
    );
    if (matches.length === 0) {
      return ok({ replaced: false, error: { code: "entry-not-found" } });
    }
    if (matches.length > 1) {
      return badRequest2("entry-ambiguous", `${matches.length} entries match; narrow the match`);
    }
    const index = entries.findIndex(
      (entry) => normalizeForDedupe(entry) === filter ||
        normalizeForDedupe(entry).includes(filter),
    );
    entries[index] = replacement;
    const trimmed = trimToBudget(entries, budget);
    atomicWrite(file, serializeEntries(entries));
    return ok({ replaced: true, trimmed });
  },

  memory_remove(args) {
    const target = args.target;
    const filter = normalizeForDedupe(String(args.match ?? ""));
    if (!filter) return badRequest("match is empty");
    const { file } =
      target === "failure"
        ? failureFileFor(args.projectId)
        : fileFor(target, args.projectId);
    const entries = readEntries(file);
    const tombstones = loadTombstones();
    const remaining = [];
    let removed = 0;
    for (const entry of entries) {
      const normalized = normalizeForDedupe(entry);
      if (normalized === filter || normalized.includes(filter)) {
        tombstones.add(`${file}:${normalized}`);
        removed += 1;
      } else {
        remaining.push(entry);
      }
    }
    if (removed === 0) return ok({ removed: 0 });
    atomicWrite(file, serializeEntries(remaining));
    saveTombstones(tombstones);
    return ok({ removed });
  },

  memory_search(args) {
    const query = normalizeForDedupe(String(args.query ?? "")).toLowerCase();
    if (!query) return badRequest("query is empty");
    const scope = args.scope ?? "current";
    const currentKey = currentProjectKey();
    const scopes =
      scope === "all"
        ? collectionScopes()
        : [{ key: currentKey, root: memoryDir }];
    const hits = [];
    const elsewhere = [];
    const seenScopes = new Set();
    for (const { key, root } of scopes) {
      if (!key || seenScopes.has(key)) continue;
      seenScopes.add(key);
      const matches = [];
      for (const [target, file] of scopeFiles(key, root)) {
        for (const entry of readEntries(file)) {
          if (entry.toLowerCase().includes(query)) {
            matches.push({ target, entry });
          }
        }
      }
      if (matches.length > 0) {
        const hit = { projectId: key, matches };
        if (key === currentKey) hits.unshift(hit);
        else elsewhere.push(hit);
      }
    }
    const response = { hits };
    if (elsewhere.length > 0) {
      response.elsewhere = elsewhere;
      response.hint = "No hits in the current scope; matches exist in other projects.";
    }
    return ok(response);
  },

  memory_get(args) {
    const target = args.target;
    const { file } =
      target === "failure"
        ? failureFileFor(args.projectId)
        : fileFor(target, args.projectId);
    const entries = readEntries(file);
    const offset = Number(args.offset ?? 0) || 0;
    const limit = Number(args.limit ?? 100) || 100;
    return ok({
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      offset,
    });
  },

  session_search(args) {
    const query = normalizeForDedupe(String(args.query ?? "")).toLowerCase();
    if (!query) return badRequest("query is empty");
    const dbSources = collectionSources.filter(
      (source) => typeof source?.db === "string" && source.db.length > 0,
    );
    if (dbSources.length === 0) {
      return ok({ hits: [], error: { code: "session-sources-empty" } });
    }
    const limit = clampCount(args.limit, SESSION_SEARCH_MAX_SESSIONS);
    const hits = [];
    const unavailable = [];
    for (const source of dbSources) {
      const result = searchSessionIndex(source, query, limit);
      if (result.error) {
        unavailable.push({ backend: source.backend ?? "unknown", code: result.error });
        continue;
      }
      for (const hit of result.hits) {
        hits.push({ ...hit, backend: source.backend ?? "pi" });
      }
    }
    const response = { hits: hits.slice(0, limit) };
    if (unavailable.length > 0) response.unavailable = unavailable;
    if (hits.length === 0 && unavailable.length === dbSources.length) {
      response.error = { code: "session-index-unavailable" };
    }
    return ok(response);
  },

  memory_status() {
    const scopes = [];
    const allTargets = ["memory", "user", "standing", "failure"];
    for (const target of allTargets) {
      const { file, budget } =
        target === "failure"
          ? failureFileFor(null)
          : fileFor(target, null);
      const entries = readEntries(file);
      const chars = entries.reduce((sum, entry) => sum + entry.length, 0);
      scopes.push({
        target,
        entries: entries.length,
        chars,
        overBudget:
          entries.length > budget.entries || chars > budget.chars,
      });
    }
    const projectKey = currentProjectKey();
    if (projectKey) {
      for (const target of ["project", "failure"]) {
        const { file, budget } = failureFileFor(projectKey);
        void budget;
        const entries = readEntries(file);
        const chars = entries.reduce((sum, entry) => sum + entry.length, 0);
        scopes.push({
          target,
          projectId: projectKey,
          entries: entries.length,
          chars,
          overBudget:
            entries.length > BUDGETS[target].entries ||
            chars > BUDGETS[target].chars,
        });
      }
    }
    return ok({
      scopes,
      projectKey,
      sources: collectionSources.length,
      deviceFile: existsSync(deviceFile),
    });
  },
};

function scopeFiles(projectKey, memoryRoot) {
  const base = memoryRoot ?? memoryDir;
  return [
    ["memory", join(base, "MEMORY.md")],
    ["user", join(base, "USER.md")],
    ["failure", join(base, "failures.md")],
    ["project", join(base, "projects", projectKey, "MEMORY.md")],
  ];
}

function collectionScopes() {
  // Current scope first (its hits lead), then every collection source —
  // each source carries its own memory root so cross-project search reads
  // the other project's files, not this server's.
  const scopes = [{ key: currentProjectKey(), root: memoryDir }];
  for (const source of collectionSources) {
    const key = source.project || projectKeyFor(source.dir);
    if (key) scopes.push({ key, root: source.memoryDir || source.dir });
  }
  return scopes;
}

/**
 * Session history search over the host's own SQLite transcript index.
 *
 * The host already persists every message in `<dataDir>/pi.sqlite` with an
 * FTS5 trigram index (`messages_fts`), so this reads that index read-only
 * instead of collecting a second copy of the transcripts (ADR decision:
 * no extra capture pipeline). Anything that goes wrong here degrades to a
 * structured code — a broken or missing index must never take the memory
 * server down.
 */
function searchSessionIndex(source, query, limit) {
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    // `mode=ro` keeps a misconfigured path from creating or mutating a host
    // database; the explicit readOnly flag is the belt to that suspenders.
    const uri = `file:${source.db.replace(/\\/g, "/")}?mode=ro`;
    db = new DatabaseSync(uri, { readOnly: true });
    const phrase = toFtsPhrase(query);
    const rows = db
      .prepare(
        `SELECT m.session_id AS sessionId, m.role AS role, m.created_at AS createdAt,
                COALESCE(s.title, '') AS title,
                snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet
           FROM messages_fts
           JOIN messages m ON m.mid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
          WHERE messages_fts MATCH ?
       ORDER BY m.created_at DESC
          LIMIT ?`,
      )
      .all(phrase, limit * SESSION_SEARCH_MESSAGES_PER_HIT);
    return { hits: groupSessionHits(rows) };
  } catch (error) {
    const fallback = searchSessionIndexWithLike(source, query, limit, error);
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // A close failure must not mask the search result.
    }
  }
}

/** FTS5 treats punctuation as syntax; a quoted phrase keeps user text literal. */
function toFtsPhrase(query) {
  return `"${query.replace(/"/g, '""')}"`;
}

/** FTS unavailable (older schema, exotic query): plain substring scan. */
function searchSessionIndexWithLike(source, query, limit, originalError) {
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const uri = `file:${source.db.replace(/\\/g, "/")}?mode=ro`;
    db = new DatabaseSync(uri, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT m.session_id AS sessionId, m.role AS role, m.created_at AS createdAt,
                COALESCE(s.title, '') AS title,
                substr(m.text, 1, 240) AS snippet
           FROM messages m
      LEFT JOIN sessions s ON s.id = m.session_id
          WHERE m.text LIKE ? ESCAPE '\\'
       ORDER BY m.created_at DESC
          LIMIT ?`,
      )
      .all(`%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`, limit * SESSION_SEARCH_MESSAGES_PER_HIT);
    return { hits: groupSessionHits(rows) };
  } catch {
    return { hits: [], error: classifyIndexError(originalError) };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function classifyIndexError(error) {
  const message = String(error?.message ?? error);
  if (/no such table: messages/i.test(message)) return "session-index-unavailable";
  if (/unable to open|no such file|ENOENT/i.test(message)) return "session-index-unavailable";
  return "session-index-error";
}

/** One hit per session, newest matches first, capped per session. */
function groupSessionHits(rows) {
  const bySession = new Map();
  for (const row of rows) {
    if (!row?.sessionId) continue;
    const hit = bySession.get(row.sessionId) ?? {
      sessionId: row.sessionId,
      title: row.title || null,
      matches: [],
    };
    if (hit.matches.length < SESSION_SEARCH_MESSAGES_PER_HIT) {
      hit.matches.push({
        role: row.role ?? "unknown",
        snippet: String(row.snippet ?? "").slice(0, SESSION_SEARCH_SNIPPET_CHARS),
        createdAt: row.createdAt ?? null,
      });
    }
    bySession.set(row.sessionId, hit);
  }
  return [...bySession.values()];
}

function clampCount(value, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return max;
  return Math.min(Math.floor(parsed), max);
}

function currentProjectKey() {
  return projectKeyFor(sessionCwd);
}

function addToScope(scopeFile, entry, target, projectId) {
  const entries = readEntries(scopeFile.file);
  const normalized = normalizeForDedupe(entry);
  if (entries.some((existing) => normalizeForDedupe(existing) === normalized)) {
    return ok({ added: false, reason: "duplicate" });
  }
  entries.push(entry);
  const trimmed = trimToBudget(entries, scopeFile.budget);
  atomicWrite(scopeFile.file, serializeEntries(entries));
  return ok({ added: true, target: target ?? "failure", projectId, trimmed });
}

// ---------------------------------------------------------------------------
// MCP protocol (stdio JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "pi-desktop-agent-memory", version: "0.1.0" };
const ok = (result) => ({ ok: true, ...result });
const badRequest = (detail) => ({
  ok: false,
  error: { code: "invalid-params", detail },
});
const badRequest2 = (code, detail) => ({
  ok: false,
  error: { code, detail },
});

const TOOL_DEFINITIONS = [
  {
    name: "memory_add",
    description:
      "Write one long-term memory fact. target ∈ memory/user/project/failure/device; project requires projectId; failure requires [category].",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user", "project", "failure", "device"] },
        entry: { type: "string" },
        projectId: { type: "string" },
        category: { type: "string" },
      },
      required: ["target", "entry"],
    },
  },
  {
    name: "memory_replace",
    description: "Replace one memory entry identified by an exact or substring match.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user", "project", "failure"] },
        match: { type: "string" },
        entry: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["target", "match", "entry"],
    },
  },
  {
    name: "memory_remove",
    description: "Remove matching memory entries (recorded as tombstones).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user", "project", "failure"] },
        match: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["target", "match"],
    },
  },
  {
    name: "memory_search",
    description:
      "Full-text search across memory scopes. Empty current-scope hits with matches elsewhere return `elsewhere`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["current", "all"] },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "List memory entries oldest-first with offset/limit pagination.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user", "project", "failure", "device"] },
        projectId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["target"],
    },
  },
  {
    name: "session_search",
    description:
      "Search this installation's session histories by keyword (host transcript index, read-only).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_status",
    description: "Budget usage, scope list, and index state for diagnostics.",
    inputSchema: { type: "object", properties: {} },
  },
];

function handleRpc(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (message.method === "notifications/initialized") return null;
  if (message.method === "tools/list") {
    return { tools: TOOL_DEFINITIONS };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const tool = tools[name];
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      };
    }
    try {
      const result = tool(message.params?.arguments ?? {});
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.ok !== true },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        },
      };
    }
  }
  if (message.id !== undefined) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    };
  }
  return null;
}

// stdio line-delimited JSON-RPC
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const response = handleRpc(message);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));

mkdirSync(memoryDir, { recursive: true });
mkdirSync(join(memoryDir, "projects"), { recursive: true });
mkdirSync(join(memoryDir, "devices"), { recursive: true });
