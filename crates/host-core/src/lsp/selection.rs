//! Server selection: which configured language server owns a given file.
//!
//! Selection is deliberately conservative. A server must be enabled, know the
//! file's extension, and find one of its root markers at the workspace root;
//! then its command must resolve on `PATH`. Anything missing means the file has
//! no server, and callers degrade silently instead of guessing.

use super::config::ServerConfig;
use std::ffi::OsStr;
use std::path::Path;

/// Servers that claim `file` inside `workspace`, in configuration order.
pub fn servers_for_file<'a>(
    servers: &'a [ServerConfig],
    workspace: &Path,
    file: &Path,
) -> Vec<&'a ServerConfig> {
    let Some(extension) = file
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
    else {
        return Vec::new();
    };
    servers
        .iter()
        .filter(|server| !server.disabled)
        .filter(|server| {
            server
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
        })
        .filter(|server| {
            server
                .root_markers
                .iter()
                .any(|marker| workspace.join(marker).exists())
        })
        .collect()
}

/// Whether `command` resolves to an executable on the current `PATH`.
pub fn command_available(command: &str) -> bool {
    command_available_in(command, std::env::var_os("PATH").as_deref())
}

pub(crate) fn command_available_in(command: &str, path: Option<&OsStr>) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    let candidate = Path::new(command);
    // A path with a separator is taken literally, never searched on PATH.
    if candidate.is_absolute() || candidate.components().count() > 1 {
        return candidate.is_file();
    }
    let Some(path) = path else {
        return false;
    };
    for directory in std::env::split_paths(path) {
        if directory.join(command).is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            if candidate.extension().is_none() {
                let pathext = std::env::var_os("PATHEXT")
                    .unwrap_or_else(|| OsStr::new(".EXE;.CMD;.BAT;.COM").to_owned());
                for extension in pathext
                    .to_string_lossy()
                    .split(';')
                    .filter(|part| !part.is_empty())
                {
                    if directory.join(format!("{command}{extension}")).is_file() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn server(name: &str, extensions: &[&str], markers: &[&str]) -> ServerConfig {
        ServerConfig {
            name: name.to_string(),
            command: name.to_string(),
            args: Vec::new(),
            extensions: extensions.iter().map(|ext| (*ext).to_string()).collect(),
            root_markers: markers.iter().map(|marker| (*marker).to_string()).collect(),
            disabled: false,
            initialization_options: None,
        }
    }

    #[test]
    fn selects_by_extension_and_root_marker() {
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("tsconfig.json"), "{}").unwrap();
        let servers = vec![
            server("typescript", &[".ts", ".tsx"], &["tsconfig.json"]),
            server("rust", &[".rs"], &["Cargo.toml"]),
        ];

        let selected = servers_for_file(&servers, workspace.path(), &workspace.path().join("a.ts"));
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].name, "typescript");

        let none = servers_for_file(&servers, workspace.path(), &workspace.path().join("a.rs"));
        assert!(none.is_empty());
    }

    #[test]
    fn never_selects_a_disabled_server() {
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("Cargo.toml"), "").unwrap();
        let mut rust = server("rust", &[".rs"], &["Cargo.toml"]);
        rust.disabled = true;

        assert!(
            servers_for_file(&[rust], workspace.path(), &workspace.path().join("a.rs")).is_empty()
        );
    }

    #[test]
    fn ignores_files_without_an_extension() {
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("Makefile"), "").unwrap();
        let servers = vec![server("make", &[".mk"], &["Makefile"])];

        assert!(servers_for_file(
            &servers,
            workspace.path(),
            &workspace.path().join("Makefile")
        )
        .is_empty());
    }

    #[test]
    fn resolves_a_command_from_the_given_path() {
        let dir = tempdir().unwrap();
        let binary = dir.path().join("typescript-language-server");
        fs::write(&binary, "").unwrap();

        let path = std::env::join_paths([dir.path()]).unwrap();
        assert!(command_available_in(
            "typescript-language-server",
            Some(path.as_os_str())
        ));
        assert!(!command_available_in(
            "missing-server",
            Some(path.as_os_str())
        ));
    }

    #[test]
    fn a_path_with_a_separator_is_not_searched() {
        let dir = tempdir().unwrap();
        let binary = dir.path().join("server");
        fs::write(&binary, "").unwrap();

        assert!(command_available_in(binary.to_str().unwrap(), None));
        assert!(!command_available_in("nested/server", None));
    }
}
