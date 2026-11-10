//! One-shot LSP client: spawn a selected server, open the file, collect the
//! diagnostics it publishes, then shut the server down.
//!
//! The client is intentionally one-shot. A long-lived per-workspace server pool
//! is a later slice; this version answers "what does the language say about
//! this file right now" without keeping child processes around, and a bounded
//! timeout means a hung server can only delay one call.
//!
//! The program and its argument vector come from the operator's own
//! configuration (`lsp.json` or the built-in defaults). They are executed as an
//! argv list, never through a shell or a command string.

use super::config::ServerConfig;
use super::protocol::{encode_message, FrameReader};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout};

/// Spawn site alias. Keeps the process construction in one named place so the
/// argv-only contract above stays visible.
type ProcessCommand = std::process::Command;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub end_character: u32,
    /// 1 = error, 2 = warning, 3 = information, 4 = hint.
    pub severity: u8,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug)]
pub enum LspClientError {
    Spawn(String),
    Io(String),
    Frame(String),
    Protocol(String),
    Server(String),
    Closed,
    Timeout,
}

impl std::fmt::Display for LspClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LspClientError::Spawn(message) => write!(f, "could not start the server: {message}"),
            LspClientError::Io(message) => write!(f, "server I/O failed: {message}"),
            LspClientError::Frame(message) => write!(f, "invalid LSP frame: {message}"),
            LspClientError::Protocol(message) => write!(f, "invalid LSP message: {message}"),
            LspClientError::Server(message) => write!(f, "server error: {message}"),
            LspClientError::Closed => write!(f, "server closed its output"),
            LspClientError::Timeout => write!(f, "server did not publish diagnostics in time"),
        }
    }
}

impl std::error::Error for LspClientError {}

/// `file://` URI for a local path, with the characters that would change the
/// URI's meaning percent-encoded.
pub fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        match ch {
            '%' => encoded.push_str("%25"),
            ' ' => encoded.push_str("%20"),
            '#' => encoded.push_str("%23"),
            '?' => encoded.push_str("%3F"),
            other => encoded.push(other),
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// LSP `languageId` for the file's extension.
pub fn language_id_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("ts") => "typescript",
        Some("tsx") => "typescriptreact",
        Some("js") | Some("mjs") | Some("cjs") => "javascript",
        Some("jsx") => "javascriptreact",
        Some("rs") => "rust",
        Some("json") => "json",
        Some("md") => "markdown",
        Some("py") => "python",
        Some("go") => "go",
        _ => "plaintext",
    }
}

fn parse_diagnostics(params: &Value) -> Vec<Diagnostic> {
    let Some(items) = params.get("diagnostics").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let range = item.get("range")?;
            let start = range.get("start")?;
            let end = range.get("end")?;
            Some(Diagnostic {
                line: start.get("line").and_then(Value::as_u64).unwrap_or(0) as u32,
                character: start.get("character").and_then(Value::as_u64).unwrap_or(0) as u32,
                end_line: end.get("line").and_then(Value::as_u64).unwrap_or(0) as u32,
                end_character: end.get("character").and_then(Value::as_u64).unwrap_or(0) as u32,
                severity: item.get("severity").and_then(Value::as_u64).unwrap_or(1) as u8,
                message: item
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                source: item
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

async fn send(stdin: &mut ChildStdin, message: Value) -> Result<(), LspClientError> {
    let body = serde_json::to_vec(&message)
        .map_err(|error| LspClientError::Protocol(error.to_string()))?;
    stdin
        .write_all(&encode_message(&body))
        .await
        .map_err(|error| LspClientError::Io(error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| LspClientError::Io(error.to_string()))
}

async fn read_message(
    stdout: &mut ChildStdout,
    reader: &mut FrameReader,
    buffer: &mut [u8],
) -> Result<Value, LspClientError> {
    loop {
        if let Some(frame) = reader.next_frame() {
            let body = frame.map_err(|error| LspClientError::Frame(format!("{error:?}")))?;
            return serde_json::from_slice(&body)
                .map_err(|error| LspClientError::Protocol(error.to_string()));
        }
        let read = stdout
            .read(buffer)
            .await
            .map_err(|error| LspClientError::Io(error.to_string()))?;
        if read == 0 {
            return Err(LspClientError::Closed);
        }
        reader.push(&buffer[..read]);
    }
}

async fn session(
    server: &ServerConfig,
    stdin: &mut ChildStdin,
    stdout: &mut ChildStdout,
    workspace: &Path,
    file: &Path,
    language_id: &str,
    text: &str,
) -> Result<Vec<Diagnostic>, LspClientError> {
    let root_uri = file_uri(workspace);
    let uri = file_uri(file);
    let initialization_options = server.initialization_options.clone().unwrap_or(Value::Null);

    send(
        stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": { "textDocument": { "publishDiagnostics": {} } },
                "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
                "initializationOptions": initialization_options,
            }
        }),
    )
    .await?;

    let mut reader = FrameReader::new();
    let mut buffer = vec![0u8; 8192];
    loop {
        let message = read_message(stdout, &mut reader, &mut buffer).await?;
        if message.get("id").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(LspClientError::Server(error.to_string()));
        }
        break;
    }

    send(
        stdin,
        json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    )
    .await?;
    send(
        stdin,
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 1,
                    "text": text,
                }
            }
        }),
    )
    .await?;

    loop {
        let message = read_message(stdout, &mut reader, &mut buffer).await?;
        if message.get("method").and_then(Value::as_str) != Some("textDocument/publishDiagnostics")
        {
            continue;
        }
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if params.get("uri").and_then(Value::as_str) == Some(uri.as_str()) {
            return Ok(parse_diagnostics(&params));
        }
    }
}

fn spawn_server(server: &ServerConfig) -> Result<tokio::process::Child, LspClientError> {
    let mut command = ProcessCommand::new(&server.command);
    command
        .args(&server.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flash when the desktop host spawns a server.
        command.creation_flags(0x0800_0000);
    }
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    command
        .spawn()
        .map_err(|error| LspClientError::Spawn(error.to_string()))
}

/// Ask `server` about `file` and return the diagnostics it publishes.
///
/// The whole exchange is bounded by `timeout`; on timeout the child is killed
/// and `LspClientError::Timeout` is returned.
pub async fn collect_diagnostics(
    server: &ServerConfig,
    workspace: &Path,
    file: &Path,
    language_id: &str,
    text: &str,
    timeout: Duration,
) -> Result<Vec<Diagnostic>, LspClientError> {
    let mut child = spawn_server(server)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| LspClientError::Spawn("server stdin is unavailable".to_string()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| LspClientError::Spawn("server stdout is unavailable".to_string()))?;

    let outcome = tokio::time::timeout(
        timeout,
        session(
            server,
            &mut stdin,
            &mut stdout,
            workspace,
            file,
            language_id,
            text,
        ),
    )
    .await;

    // Best-effort shutdown; kill regardless so a wedged server cannot linger.
    let _ = send(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": null }),
    )
    .await;
    let _ = send(&mut stdin, json!({ "jsonrpc": "2.0", "method": "exit" })).await;
    let _ = child.kill().await;

    match outcome {
        Err(_) => Err(LspClientError::Timeout),
        Ok(result) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn builds_a_file_uri_without_backslashes() {
        let uri = file_uri(&PathBuf::from("C:\\work dir\\a.ts"));
        assert_eq!(uri, "file:///C:/work%20dir/a.ts");
    }

    #[test]
    fn encodes_characters_that_change_the_uri() {
        let uri = file_uri(&PathBuf::from("/tmp/a#b?c%.ts"));
        assert_eq!(uri, "file:///tmp/a%23b%3Fc%25.ts");
    }

    #[test]
    fn maps_extensions_to_language_ids() {
        assert_eq!(language_id_for_path(Path::new("a.ts")), "typescript");
        assert_eq!(language_id_for_path(Path::new("a.tsx")), "typescriptreact");
        assert_eq!(language_id_for_path(Path::new("a.rs")), "rust");
        assert_eq!(language_id_for_path(Path::new("a.unknownext")), "plaintext");
    }

    #[test]
    fn parses_published_diagnostics() {
        let params = json!({
            "uri": "file:///a.ts",
            "diagnostics": [
                {
                    "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } },
                    "severity": 1,
                    "message": "Cannot find name 'foo'.",
                    "source": "ts"
                },
                { "message": "no range" }
            ]
        });
        let parsed = parse_diagnostics(&params);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].line, 1);
        assert_eq!(parsed[0].character, 2);
        assert_eq!(parsed[0].severity, 1);
        assert_eq!(parsed[0].source.as_deref(), Some("ts"));
    }

    #[test]
    fn defaults_a_missing_severity_to_error() {
        let params = json!({
            "diagnostics": [{
                "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
                "message": "broken"
            }]
        });
        assert_eq!(parse_diagnostics(&params)[0].severity, 1);
    }
}
