//! Language-server integration for the desktop host.
//!
//! Configuration (built-in servers + `lsp.json` overrides), the LSP framing
//! codec, server selection, and a one-shot client that collects diagnostics.

mod client;
mod config;
// The client consumes the codec; keep the module compiled without dead-code
// noise while more of the protocol surface lands.
#[allow(dead_code)]
mod protocol;
mod selection;

#[allow(unused_imports)]
pub use client::{collect_diagnostics, language_id_for_path, Diagnostic, LspClientError};
#[allow(unused_imports)]
pub use config::{load_servers, LspConfigError, ServerConfig};
#[allow(unused_imports)]
pub use protocol::{encode_message, FrameError, FrameReader};
#[allow(unused_imports)]
pub use selection::{command_available, servers_for_file};
