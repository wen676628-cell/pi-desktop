//! Per-workspace language-server pool.
//!
//! Spawning a server for every write costs a process start plus an initialize
//! handshake each time. The pool keeps one session per (workspace, server
//! command) alive, sends `didChange` for later edits, and shuts the server down
//! after it has been idle for [`IDLE_TIMEOUT`].
//!
//! A session that dies, times out, or fails the handshake is dropped and the
//! caller gets `None`; the next write starts a fresh one. Requests for the same
//! key serialize on that session, so two edits can never interleave frames.

use super::client::{
    file_uri, parse_diagnostics, read_message, send, spawn_server, Diagnostic, LspClientError,
};
use super::config::ServerConfig;
use super::protocol::FrameReader;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

/// A server no write has touched for this long is shut down by the reaper.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const REAP_INTERVAL: Duration = Duration::from_secs(60);
/// The initialize handshake is bounded so a wedged server cannot stall an edit.
const START_TIMEOUT: Duration = Duration::from_secs(3);

type Entry = Arc<Mutex<Option<Session>>>;

static POOL: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
static REAPER: OnceLock<()> = OnceLock::new();

fn pool() -> &'static Mutex<HashMap<String, Entry>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pool_key(server: &ServerConfig, workspace: &Path) -> String {
    // The command and arguments are part of the key: changing them in
    // `lsp.json` must not reuse a process started with the old argv.
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        workspace.display(),
        server.name,
        server.command,
        server.args.join("\u{0}")
    )
}

fn ensure_reaper() {
    if REAPER.set(()).is_ok() {
        tokio::spawn(async {
            let mut ticker = tokio::time::interval(REAP_INTERVAL);
            loop {
                ticker.tick().await;
                reap_idle().await;
            }
        });
    }
}

async fn reap_idle() {
    let entries: Vec<Entry> = {
        let map = pool().lock().await;
        map.values().cloned().collect()
    };
    for entry in entries {
        if let Ok(mut guard) = entry.try_lock() {
            let stale = guard
                .as_ref()
                .map(|session| session.idle_elapsed() > IDLE_TIMEOUT)
                .unwrap_or(false);
            if stale {
                if let Some(session) = guard.take() {
                    session.shutdown().await;
                }
            }
        }
    }
}

/// Ask a pooled server for diagnostics, starting it on first use.
///
/// Returns `None` when no server could answer within `timeout`; a failed
/// session is shut down so the next call starts clean.
pub async fn diagnostics(
    server: &ServerConfig,
    workspace: &Path,
    file: &Path,
    language_id: &str,
    text: &str,
    timeout: Duration,
) -> Option<Vec<Diagnostic>> {
    ensure_reaper();
    let key = pool_key(server, workspace);
    let entry = {
        let mut map = pool().lock().await;
        map.entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let mut guard = entry.lock().await;

    let mut slot = guard.take();
    let healthy = slot
        .as_mut()
        .map(|session| session.is_alive() && session.idle_elapsed() <= IDLE_TIMEOUT)
        .unwrap_or(false);
    if !healthy {
        if let Some(session) = slot.take() {
            session.shutdown().await;
        }
    }

    if slot.is_some() {
        let result = {
            let session = slot.as_mut().expect("checked above");
            session.diagnostics(file, language_id, text, timeout).await
        };
        match result {
            Ok(diagnostics) => {
                *guard = slot;
                return Some(diagnostics);
            }
            Err(_) => {
                if let Some(session) = slot.take() {
                    session.shutdown().await;
                }
            }
        }
    }

    let started = tokio::time::timeout(START_TIMEOUT, Session::start(server, workspace)).await;
    let mut session = match started {
        Ok(Ok(session)) => session,
        Ok(Err(_)) | Err(_) => return None,
    };
    match session.diagnostics(file, language_id, text, timeout).await {
        Ok(diagnostics) => {
            *guard = Some(session);
            Some(diagnostics)
        }
        Err(_) => {
            session.shutdown().await;
            None
        }
    }
}

/// Shut every pooled server down. Used by tests and by host shutdown.
pub async fn shutdown_all() {
    let entries: Vec<Entry> = {
        let mut map = pool().lock().await;
        map.drain().map(|(_, entry)| entry).collect()
    };
    for entry in entries {
        let mut guard = entry.lock().await;
        if let Some(session) = guard.take() {
            session.shutdown().await;
        }
    }
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    reader: FrameReader,
    buffer: Vec<u8>,
    versions: HashMap<String, i64>,
    last_used: Instant,
}

impl Session {
    async fn start(server: &ServerConfig, workspace: &Path) -> Result<Self, LspClientError> {
        let mut child = spawn_server(server)?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| LspClientError::Spawn("server stdin is unavailable".to_string()))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| LspClientError::Spawn("server stdout is unavailable".to_string()))?;
        let root_uri = file_uri(workspace);
        send(
            &mut stdin,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "processId": std::process::id(),
                    "rootUri": root_uri,
                    "capabilities": { "textDocument": { "publishDiagnostics": {} } },
                    "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
                    "initializationOptions": server
                        .initialization_options
                        .clone()
                        .unwrap_or(Value::Null),
                }
            }),
        )
        .await?;

        let mut reader = FrameReader::new();
        let mut buffer = vec![0u8; 8192];
        loop {
            let message = read_message(&mut stdout, &mut reader, &mut buffer).await?;
            if message.get("method").is_some() {
                // A server request (`client/registerCapability`, progress) gets a
                // null answer so the handshake cannot deadlock waiting on us.
                if let Some(id) = message.get("id") {
                    let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
                    let _ = send(&mut stdin, reply).await;
                }
                continue;
            }
            if message.get("id").and_then(Value::as_i64) != Some(1) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(LspClientError::Server(error.to_string()));
            }
            break;
        }
        send(
            &mut stdin,
            json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
        )
        .await?;

        Ok(Self {
            child,
            stdin,
            stdout,
            reader,
            buffer,
            versions: HashMap::new(),
            last_used: Instant::now(),
        })
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn idle_elapsed(&self) -> Duration {
        self.last_used.elapsed()
    }

    async fn diagnostics(
        &mut self,
        file: &Path,
        language_id: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<Vec<Diagnostic>, LspClientError> {
        let uri = file_uri(file);
        let version = {
            let version = self.versions.entry(uri.clone()).or_insert(0);
            *version += 1;
            *version
        };
        let message = if version == 1 {
            json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": { "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": version,
                    "text": text,
                }}
            })
        } else {
            json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didChange",
                "params": {
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [{ "text": text }],
                }
            })
        };
        send(&mut self.stdin, message).await?;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(LspClientError::Timeout);
            }
            let message = tokio::time::timeout(
                remaining,
                read_message(&mut self.stdout, &mut self.reader, &mut self.buffer),
            )
            .await
            .map_err(|_| LspClientError::Timeout)??;

            if message.get("method").is_some() {
                if let Some(id) = message.get("id") {
                    // A server request: answer null so it cannot deadlock us.
                    let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
                    let _ = send(&mut self.stdin, reply).await;
                    continue;
                }
            }
            if message.get("method").and_then(Value::as_str)
                != Some("textDocument/publishDiagnostics")
            {
                continue;
            }
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if params.get("uri").and_then(Value::as_str) == Some(uri.as_str()) {
                self.last_used = Instant::now();
                return Ok(parse_diagnostics(&params));
            }
        }
    }

    async fn shutdown(mut self) {
        let _ = send(
            &mut self.stdin,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": null }),
        )
        .await;
        let _ = send(
            &mut self.stdin,
            json!({ "jsonrpc": "2.0", "method": "exit" }),
        )
        .await;
        let _ = self.child.kill().await;
    }
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    const FAKE_LSP_SERVER: &str = r#"import json
import sys

counter = sys.argv[1]
with open(counter, "a", encoding="utf-8") as handle:
    handle.write("start\n")

def read_message():
    headers = {}
    line = sys.stdin.buffer.readline()
    while line and line not in (b"\r\n", b"\n"):
        name, _, value = line.decode("utf-8").partition(":")
        headers[name.strip().lower()] = value.strip()
        line = sys.stdin.buffer.readline()
    if not line:
        return None
    length = int(headers.get("content-length", "0"))
    return json.loads(sys.stdin.buffer.read(length))

def send(payload):
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

def publish(uri):
    send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
          "params": {"uri": uri, "diagnostics": [{
              "range": {"start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 1}},
              "severity": 1, "message": "pooled diagnostic"}]}})

while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {}}})
    elif method == "textDocument/didOpen":
        publish(message["params"]["textDocument"]["uri"])
    elif method == "textDocument/didChange":
        publish(message["params"]["textDocument"]["uri"])
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": message["id"], "result": None})
    elif method == "exit":
        break
"#;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reuses_one_server_for_consecutive_requests() {
        let ws = tempdir().unwrap();
        fs::write(ws.path().join("tsconfig.json"), "{}").unwrap();
        let counter = ws.path().join("starts.txt");
        let server_path = ws.path().join("fake_pool_lsp.py");
        fs::write(&server_path, FAKE_LSP_SERVER).unwrap();
        let file = ws.path().join("a.ts");
        fs::write(&file, "const x = 1;\n").unwrap();

        let server = ServerConfig {
            name: "pooled".to_string(),
            command: "python3".to_string(),
            args: vec![
                server_path.to_string_lossy().into_owned(),
                counter.to_string_lossy().into_owned(),
            ],
            extensions: vec![".ts".to_string()],
            root_markers: vec!["tsconfig.json".to_string()],
            disabled: false,
            initialization_options: None,
        };

        let first = diagnostics(
            &server,
            ws.path(),
            &file,
            "typescript",
            "const x = 1;\n",
            Duration::from_secs(3),
        )
        .await;
        let second = diagnostics(
            &server,
            ws.path(),
            &file,
            "typescript",
            "const x = 2;\n",
            Duration::from_secs(3),
        )
        .await;

        assert_eq!(first.as_ref().map(Vec::len), Some(1));
        assert_eq!(second.as_ref().map(Vec::len), Some(1));
        let starts = fs::read_to_string(&counter).unwrap_or_default();
        assert_eq!(
            starts.lines().count(),
            1,
            "server was started more than once"
        );

        shutdown_all().await;
    }
}
