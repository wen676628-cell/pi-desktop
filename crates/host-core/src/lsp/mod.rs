//! Language-server integration for the desktop host.
//!
//! Configuration (built-in servers + `lsp.json` overrides), the LSP framing
//! codec, server selection, a per-workspace server pool, and the post-write
//! attachment used by Edit/Write.

mod client;
mod config;
mod pool;
// The client consumes the codec; keep the module compiled without dead-code
// noise while more of the protocol surface lands.
#[allow(dead_code)]
mod protocol;
mod selection;

use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[allow(unused_imports)]
pub use client::{collect_diagnostics, language_id_for_path, Diagnostic, LspClientError};
#[allow(unused_imports)]
pub use config::{load_servers, LspConfigError, ServerConfig};
#[allow(unused_imports)]
pub use pool::shutdown_all;
#[allow(unused_imports)]
pub use protocol::{encode_message, FrameError, FrameReader};
#[allow(unused_imports)]
pub use selection::{command_available, servers_for_file};

/// A write must not wait on a language server for long: the diagnostics pass is
/// best-effort and a slow server is skipped instead of delaying the edit.
const WRITE_DIAGNOSTICS_TIMEOUT: Duration = Duration::from_millis(1_500);

#[derive(Debug, Clone, Serialize)]
pub struct WriteDiagnostics {
    pub server: String,
    pub diagnostics: Vec<Diagnostic>,
}

/// Diagnostics for one file, through the pooled server for this workspace.
///
/// The language id comes from the file extension. Returns `None` when the
/// server cannot answer inside `timeout`.
pub async fn diagnostics_with_timeout(
    server: &ServerConfig,
    workspace: &Path,
    file: &Path,
    text: &str,
    timeout: Duration,
) -> Option<Vec<Diagnostic>> {
    let language_id = language_id_for_path(file);
    pool::diagnostics(server, workspace, file, language_id, text, timeout).await
}

/// Diagnostics for a file that was just written.
///
/// Returns `None` when no configured server claims the file, its binary is
/// unavailable, or the server did not answer within the budget. It never
/// fails the write: every error path collapses to `None`.
pub async fn diagnostics_for_write(
    workspace: &Path,
    file: &Path,
    text: &str,
) -> Option<WriteDiagnostics> {
    let home = crate::config_backend::pi_home();
    let servers = load_servers(Some(&home), Some(workspace)).ok()?;
    let selected = servers_for_file(&servers, workspace, file);
    let server = selected.first()?;
    if !command_available(&server.command) {
        return None;
    }
    let diagnostics =
        diagnostics_with_timeout(server, workspace, file, text, WRITE_DIAGNOSTICS_TIMEOUT).await?;
    Some(WriteDiagnostics {
        server: server.name.clone(),
        diagnostics,
    })
}

/// Blocking form for the synchronous tool bodies. Those bodies run on a tokio
/// blocking thread, so driving the future with the current handle is safe.
pub fn blocking_diagnostics_for_write(
    workspace: &Path,
    file: &Path,
    text: &str,
) -> Option<WriteDiagnostics> {
    let handle = tokio::runtime::Handle::try_current().ok()?;
    handle.block_on(diagnostics_for_write(workspace, file, text))
}
