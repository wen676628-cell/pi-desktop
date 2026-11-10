//! Language-server integration for the desktop host.
//!
//! First slice: configuration (built-in servers + `lsp.json` overrides), the
//! LSP framing codec, and server selection for a file. Spawning a server and
//! collecting diagnostics build on this without changing the shapes here.

mod config;
// The client that consumes framing lands next; the codec stays compiled and
// tested until then without dead-code noise.
#[allow(dead_code)]
mod protocol;
mod selection;

// The client slice consumes the type and codec re-exports below; keep them
// public now so the next increment does not churn this surface.
#[allow(unused_imports)]
pub use config::{load_servers, LspConfigError, ServerConfig};
#[allow(unused_imports)]
pub use protocol::{encode_message, FrameError, FrameReader};
#[allow(unused_imports)]
pub use selection::{command_available, servers_for_file};
