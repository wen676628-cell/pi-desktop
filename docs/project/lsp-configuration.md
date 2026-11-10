# Language-server integration

Foundation slice for LSP support, modelled on oh-my-pi's server discovery but
scoped to what the host can verify today: configuration, framing, and server
selection. Spawning a server and collecting diagnostics build on this without
changing the shapes below.

## Configuration

Both shapes are accepted (`servers` wrapper or a flat map):

```json
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": [".ts", ".tsx"],
      "rootMarkers": ["tsconfig.json", "package.json"],
      "initializationOptions": {}
    }
  }
}
```

Precedence is shallow per server, lowest to highest:

1. built-in defaults (`typescript`, `rust`);
2. `<PI_HOME>/lsp.json`;
3. `<workspace>/.pi/lsp.json`.

A source overrides only the fields it names; `disabled: true` turns a built-in
off. A server that is not built in must name a `command`, otherwise it is
ignored. Malformed JSON is reported with its path — callers log and skip it.

## Selection

`servers_for_file` keeps a server when all of these hold:

- it is not disabled;
- its extension list contains the file's extension (case-insensitive, leading
  dot normalized);
- one of its root markers exists at the workspace root.

`command_available` then answers whether the binary resolves on `PATH`; a server
without a binary is reported as unavailable rather than started and crashed.

## Framing

`FrameReader` is incremental (`Content-Length: N\r\n\r\n<body>`), tolerates
lowercase header names, drains malformed headers and reports
`MissingContentLength` / `InvalidContentLength` / `TooLarge` instead of stalling,
and caps a body at 16 MiB.

## RPC

`lsp.status` returns the merged server list plus an `available` flag per server;
with `workspaceRoot` and `path` it also returns `selected`, the names of the
servers that claim that file. Read-only: no process is spawned.

## Next slices

1. Spawn a selected server, `initialize`, `textDocument/didOpen`, and collect
   `publishDiagnostics` with a bounded wait.
2. Surface diagnostics in the Edit/Write tool result and in the renderer.
3. Cache servers per workspace root and shut them down on session end.
