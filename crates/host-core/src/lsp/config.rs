//! LSP server configuration: built-in defaults plus `lsp.json` overrides.
//!
//! The file shape follows the one editors and other agents already use:
//!
//! ```json
//! { "servers": { "typescript": { "command": "typescript-language-server", "args": ["--stdio"] } } }
//! }
//! ```
//!
//! A flat map (no `servers` wrapper) is accepted too. Precedence is shallow per
//! server: a higher source overrides only the fields it names, and entries it
//! does not mention keep their lower value. Unknown servers require a `command`
//! to be usable; without one they are ignored.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Extensions with a leading dot, compared case-insensitively.
    pub extensions: Vec<String>,
    /// Files/directories that must exist at the workspace root.
    pub root_markers: Vec<String>,
    pub disabled: bool,
    pub initialization_options: Option<Value>,
}

#[derive(Debug)]
pub struct LspConfigError {
    pub path: PathBuf,
    pub message: String,
}

impl std::fmt::Display for LspConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path.display(), self.message)
    }
}

impl std::error::Error for LspConfigError {}

fn server(
    name: &str,
    command: &str,
    args: &[&str],
    extensions: &[&str],
    root_markers: &[&str],
) -> ServerConfig {
    ServerConfig {
        name: name.to_string(),
        command: command.to_string(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        extensions: extensions.iter().map(|ext| (*ext).to_string()).collect(),
        root_markers: root_markers
            .iter()
            .map(|marker| (*marker).to_string())
            .collect(),
        disabled: false,
        initialization_options: None,
    }
}

/// Servers every PI-Desktop install starts with. A missing binary is handled by
/// selection, not by this list.
pub fn default_servers() -> Vec<ServerConfig> {
    vec![
        server(
            "typescript",
            "typescript-language-server",
            &["--stdio"],
            &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
            &["tsconfig.json", "package.json"],
        ),
        server("rust", "rust-analyzer", &[], &[".rs"], &["Cargo.toml"]),
    ]
}

fn normalize_extension(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('.') {
        trimmed.to_ascii_lowercase()
    } else {
        format!(".{}", trimmed.to_ascii_lowercase())
    }
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn apply_entry(base: &mut ServerConfig, entry: &Value) {
    let Some(object) = entry.as_object() else {
        return;
    };
    if let Some(command) = object.get("command").and_then(Value::as_str) {
        base.command = command.to_string();
    }
    if let Some(args) = string_list(object.get("args")) {
        base.args = args;
    }
    if let Some(extensions) = string_list(object.get("extensions")) {
        base.extensions = extensions
            .iter()
            .map(|ext| normalize_extension(ext))
            .filter(|ext| !ext.is_empty())
            .collect();
    }
    if let Some(markers) = string_list(
        object
            .get("rootMarkers")
            .or_else(|| object.get("root_markers")),
    ) {
        base.root_markers = markers;
    }
    if let Some(disabled) = object.get("disabled").and_then(Value::as_bool) {
        base.disabled = disabled;
    }
    if let Some(options) = object
        .get("initializationOptions")
        .or_else(|| object.get("initialization_options"))
    {
        base.initialization_options = Some(options.clone());
    }
}

fn parse_file(text: &str) -> Result<Vec<(String, Value)>, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|err| err.to_string())?;
    let Some(root) = parsed.as_object() else {
        return Err("lsp.json must be a JSON object".to_string());
    };
    let entries = root
        .get("servers")
        .and_then(Value::as_object)
        .or(Some(root))
        .map(|servers: &Map<String, Value>| {
            servers
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(entries)
}

fn read_file(path: &Path) -> Result<Option<String>, LspConfigError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(LspConfigError {
            path: path.to_path_buf(),
            message: err.to_string(),
        }),
    }
}

/// Merge the built-in servers with the user file and the workspace file.
///
/// `agent_dir` is the active PI_HOME; `workspace` is the project root, whose
/// overrides live in `<workspace>/.pi/lsp.json`. Missing files are normal; a
/// malformed file is an error the caller may log and skip.
pub fn load_servers(
    agent_dir: Option<&Path>,
    workspace: Option<&Path>,
) -> Result<Vec<ServerConfig>, LspConfigError> {
    let mut servers = default_servers();
    let mut sources: Vec<PathBuf> = Vec::new();
    if let Some(dir) = agent_dir {
        sources.push(dir.join("lsp.json"));
    }
    if let Some(root) = workspace {
        sources.push(root.join(".pi").join("lsp.json"));
    }

    for path in sources {
        let Some(text) = read_file(&path)? else {
            continue;
        };
        let entries = parse_file(&text).map_err(|message| LspConfigError {
            path: path.clone(),
            message,
        })?;
        for (name, value) in entries {
            if let Some(existing) = servers.iter_mut().find(|server| server.name == name) {
                apply_entry(existing, &value);
                continue;
            }
            // A new server is only usable with an explicit command.
            let command = value
                .as_object()
                .and_then(|object| object.get("command"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if command.is_empty() {
                continue;
            }
            let mut created = ServerConfig {
                name: name.clone(),
                command,
                args: Vec::new(),
                extensions: Vec::new(),
                root_markers: Vec::new(),
                disabled: false,
                initialization_options: None,
            };
            apply_entry(&mut created, &value);
            servers.push(created);
        }
    }

    servers.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(servers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn defaults_cover_typescript_and_rust() {
        let servers = default_servers();
        assert!(servers.iter().any(|server| server.name == "typescript"));
        assert!(servers.iter().any(|server| server.name == "rust"));
    }

    #[test]
    fn user_file_overrides_only_named_fields() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("lsp.json"),
            r#"{ "servers": { "typescript": { "args": ["--stdio", "--log-level", "4"] } } }"#,
        )
        .unwrap();

        let servers = load_servers(Some(dir.path()), None).unwrap();
        let typescript = servers
            .iter()
            .find(|server| server.name == "typescript")
            .unwrap();
        assert_eq!(typescript.command, "typescript-language-server");
        assert_eq!(typescript.args, ["--stdio", "--log-level", "4"]);
        assert!(typescript.extensions.contains(&".ts".to_string()));
    }

    #[test]
    fn workspace_file_wins_over_user_file() {
        let user = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(
            user.path().join("lsp.json"),
            r#"{ "servers": { "rust": { "disabled": true } } }"#,
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join(".pi")).unwrap();
        fs::write(
            workspace.path().join(".pi").join("lsp.json"),
            r#"{ "servers": { "rust": { "disabled": false } } }"#,
        )
        .unwrap();

        let servers = load_servers(Some(user.path()), Some(workspace.path())).unwrap();
        let rust = servers.iter().find(|server| server.name == "rust").unwrap();
        assert!(!rust.disabled);
    }

    #[test]
    fn custom_server_requires_a_command() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("lsp.json"),
            r#"{ "servers": { "python": { "extensions": [".py"] } } }"#,
        )
        .unwrap();

        let servers = load_servers(Some(dir.path()), None).unwrap();
        assert!(!servers.iter().any(|server| server.name == "python"));
    }

    #[test]
    fn flat_shape_is_accepted() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("lsp.json"),
            r#"{ "typescript": { "command": "deno", "extensions": ["ts"] } }"#,
        )
        .unwrap();

        let servers = load_servers(Some(dir.path()), None).unwrap();
        let typescript = servers
            .iter()
            .find(|server| server.name == "typescript")
            .unwrap();
        assert_eq!(typescript.command, "deno");
        assert_eq!(typescript.extensions, [".ts"]);
    }

    #[test]
    fn malformed_file_reports_its_path() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("lsp.json"), "{ not json").unwrap();

        let error = load_servers(Some(dir.path()), None).unwrap_err();
        assert!(error.path.ends_with("lsp.json"));
    }
}
