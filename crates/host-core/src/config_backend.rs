//! Single owner for the pi home configuration files.
//!
//! Desktop and the pi CLI share `PI_HOME` (`PI_CODING_AGENT_DIR`, else
//! `~/.pi/agent`). `models.json` describes providers and models, `auth.json`
//! holds API keys, `settings.json` holds non-secret pi settings. This module is
//! the only host code allowed to read or write those files; provider RPCs go
//! through it so a Desktop edit and a CLI edit converge on one file set.

use crate::db::Database;
use crate::providers::{
    create_provider_with_id, get_secret_for_provider, list_providers, ModelBinding,
    ProviderCreateInput, SecretStore,
};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const MODELS_FILE: &str = "models.json";
const AUTH_FILE: &str = "auth.json";
const SETTINGS_FILE: &str = "settings.json";
const MANIFEST_FILE: &str = ".pi-desktop-managed.json";

/// The shared pi home: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
pub fn pi_home() -> PathBuf {
    if let Some(configured) = env::var_os("PI_CODING_AGENT_DIR") {
        let path = PathBuf::from(configured);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".pi").join("agent")
}

fn read_json(path: &Path) -> Value {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn read_manifest(home: &Path) -> BTreeSet<String> {
    read_json(&home.join(MANIFEST_FILE))
        .get("managed")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Hash of the three files (content plus coarse metadata). Any external edit
/// changes the token, which callers use to invalidate caches.
pub fn version_token(home: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    for name in [MODELS_FILE, AUTH_FILE, SETTINGS_FILE] {
        let path = home.join(name);
        hasher.update(name.as_bytes());
        match fs::metadata(&path) {
            Ok(meta) => {
                hasher.update(meta.len().to_le_bytes());
                if let Ok(modified) = meta.modified() {
                    if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                        hasher.update(duration.as_nanos().to_le_bytes());
                    }
                }
                if let Ok(bytes) = fs::read(&path) {
                    hasher.update(&bytes);
                }
            }
            Err(_) => hasher.update(b"missing"),
        }
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

/// Redacted view for RPC. Never returns an API key.
pub fn snapshot(home: &Path) -> Result<Value> {
    let models = read_json(&home.join(MODELS_FILE));
    let auth = read_json(&home.join(AUTH_FILE));
    let mut providers = Vec::new();
    if let Some(map) = models.get("providers").and_then(Value::as_object) {
        for (id, record) in map {
            let model_ids: Vec<String> = record
                .get("models")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| {
                            row.as_str().map(str::to_string).or_else(|| {
                                row.get("id").and_then(Value::as_str).map(str::to_string)
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            providers.push(json!({
                "id": id,
                "name": record.get("name").and_then(Value::as_str).unwrap_or(id),
                "baseUrl": record.get("baseUrl").and_then(Value::as_str),
                "api": record.get("api").and_then(Value::as_str),
                "modelIds": model_ids,
                "hasSecret": auth.get(id).and_then(|entry| entry.get("key")).and_then(Value::as_str).is_some(),
            }));
        }
    }
    Ok(json!({
        "home": home.to_string_lossy(),
        "version": version_token(home)?,
        "files": {
            "models": home.join(MODELS_FILE).is_file(),
            "auth": home.join(AUTH_FILE).is_file(),
            "settings": home.join(SETTINGS_FILE).is_file(),
        },
        "providers": providers,
    }))
}

fn api_style_from_pi(value: Option<&str>) -> String {
    match value
        .unwrap_or("openai-completions")
        .to_ascii_lowercase()
        .as_str()
    {
        "openai-responses" | "openai_responses" | "responses" => "openai_responses",
        "anthropic-messages" | "anthropic_messages" | "anthropic" => "anthropic_messages",
        _ => "openai_completions",
    }
    .to_string()
}

fn pi_api_from_style(value: Option<&str>, protocol: Option<&str>) -> &'static str {
    match value.unwrap_or("").to_ascii_lowercase().as_str() {
        "openai_responses" | "openai-responses" | "responses" => "openai-responses",
        "anthropic_messages" | "anthropic-messages" | "anthropic" => "anthropic-messages",
        _ => match protocol.unwrap_or("").to_ascii_lowercase().as_str() {
            "responses" => "openai-responses",
            "anthropic" => "anthropic-messages",
            _ => "openai-completions",
        },
    }
}

fn model_bindings(record: &Value) -> Option<Vec<ModelBinding>> {
    let rows = record.get("models")?.as_array()?;
    let models: Vec<ModelBinding> = rows
        .iter()
        .filter_map(|row| {
            let id = row
                .as_str()
                .map(str::to_string)
                .or_else(|| row.get("id").and_then(Value::as_str).map(str::to_string))?;
            serde_json::from_value(json!({ "id": id })).ok()
        })
        .collect();
    (!models.is_empty()).then_some(models)
}

/// Import providers that exist only in the CLI files into SQLite.
///
/// Matching is by `vendor_key == models.json provider id`; existing Desktop
/// rows are never overwritten. Returns how many rows were created.
pub fn import_providers(db: &Database, secrets: &SecretStore, home: &Path) -> Result<usize> {
    let models = read_json(&home.join(MODELS_FILE));
    let auth = read_json(&home.join(AUTH_FILE));
    let Some(map) = models.get("providers").and_then(Value::as_object) else {
        return Ok(0);
    };
    let existing = list_providers(db, secrets, true)?;
    let mut imported = 0;
    for (id, record) in map {
        if existing.iter().any(|p| p.vendor_key == *id) {
            continue;
        }
        let Some(bindings) = model_bindings(record) else {
            continue;
        };
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        let secret = auth
            .get(id)
            .and_then(|entry| entry.get("key").or_else(|| entry.get("apiKey")))
            .and_then(Value::as_str)
            .map(str::to_string);
        let input = ProviderCreateInput {
            name,
            vendor_key: Some(id.clone()),
            provider_type: Some("openai_compatible".into()),
            protocol: Some("openai_compatible".into()),
            base_url: record
                .get("baseUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
            auth_kind: Some("api_key_and_base_url".into()),
            models: Some(bindings),
            default_model_id: None,
            secret_value: secret,
            api_style: Some(api_style_from_pi(record.get("api").and_then(Value::as_str))),
            oauth_account_label: None,
            headers: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
        };
        create_provider_with_id(db, secrets, id, input)
            .with_context(|| format!("import provider {id} from {}", home.display()))?;
        imported += 1;
    }
    Ok(imported)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config"),
        std::process::id()
    ));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(path);
            fs::rename(&tmp, path).map_err(Into::into)
        }
    }
}

/// Publish every Desktop-owned provider into `models.json` / `auth.json`.
///
/// CLI-only providers and unknown keys are preserved. A manifest records which
/// ids Desktop owns so deleting one removes it once, without touching rows that
/// only exist in the CLI files.
pub fn export_providers(db: &Database, secrets: &SecretStore, home: &Path) -> Result<usize> {
    let providers = list_providers(db, secrets, true)?;
    let mut models = read_json(&home.join(MODELS_FILE));
    let mut auth = read_json(&home.join(AUTH_FILE));
    if !models.is_object() {
        models = json!({});
    }
    if !auth.is_object() {
        auth = json!({});
    }
    if models.get("providers").and_then(Value::as_object).is_none() {
        models["providers"] = json!({});
    }
    let managed = read_manifest(home);
    let mut current = BTreeSet::new();
    let mut exported = 0;

    for provider in &providers {
        if provider.owner_plugin_id.is_some() {
            continue;
        }
        current.insert(provider.id.clone());
        let entry = json!({
            "name": provider.name,
            "baseUrl": provider.base_url,
            "api": pi_api_from_style(provider.api_style.as_deref(), Some(&provider.protocol)),
            "models": provider.models.iter().map(|m| json!({ "id": m.id })).collect::<Vec<_>>(),
        });
        merge_provider_entry(&mut models, &provider.id, entry);
        match get_secret_for_provider(db, secrets, &provider.id) {
            Ok(Some(secret)) => {
                let mut record = auth
                    .get(&provider.id)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                record.insert("type".into(), json!("api_key"));
                record.insert("key".into(), json!(secret));
                auth[&provider.id] = Value::Object(record);
            }
            _ => {}
        }
        exported += 1;
    }

    for stale in managed.difference(&current) {
        if let Some(map) = models.get_mut("providers").and_then(Value::as_object_mut) {
            map.remove(stale);
        }
        if let Some(map) = auth.as_object_mut() {
            map.remove(stale);
        }
    }

    atomic_write(
        &home.join(MODELS_FILE),
        serde_json::to_vec_pretty(&models)?.as_slice(),
    )?;
    atomic_write(
        &home.join(AUTH_FILE),
        serde_json::to_vec_pretty(&auth)?.as_slice(),
    )?;
    atomic_write(
        &home.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(&json!({ "managed": current }))?.as_slice(),
    )?;
    Ok(exported)
}

fn merge_provider_entry(models: &mut Value, id: &str, entry: Value) {
    let Some(map) = models.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    let mut record: Map<String, Value> = map
        .get(id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(fields) = entry.as_object() {
        for (key, value) in fields {
            if !value.is_null() {
                record.insert(key.clone(), value.clone());
            }
        }
    }
    map.insert(id.to_string(), Value::Object(record));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-config-backend-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn snapshot_reads_models_auth_and_version_changes_on_edit() {
        let home = temp_home("snapshot");
        fs::write(
            home.join(MODELS_FILE),
            r#"{"providers":{"cli":{"name":"CLI","baseUrl":"https://x/v1","api":"openai-completions","models":[{"id":"m1"}]}}}"#,
        )
        .unwrap();
        fs::write(
            home.join(AUTH_FILE),
            r#"{"cli":{"type":"api_key","key":"sk-test"}}"#,
        )
        .unwrap();
        let first = snapshot(&home).unwrap();
        assert_eq!(first["providers"][0]["id"], "cli");
        assert_eq!(first["providers"][0]["hasSecret"], true);
        assert!(!first.to_string().contains("sk-test"));
        let version = first["version"].as_str().unwrap().to_string();
        fs::write(
            home.join(AUTH_FILE),
            r#"{"cli":{"type":"api_key","key":"sk-other"}}"#,
        )
        .unwrap();
        assert_ne!(version, version_token(&home).unwrap());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn imports_cli_providers_and_exports_desktop_changes() {
        use crate::db::Database;
        use crate::providers::{create_provider, delete_provider, list_providers, SecretStore};

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        fs::write(
            home.join(MODELS_FILE),
            r#"{"providers":{"cli":{"name":"CLI gateway","baseUrl":"https://cli/v1","api":"openai-completions","models":[{"id":"cli-model"}]}}}"#,
        )
        .unwrap();
        fs::write(
            home.join(AUTH_FILE),
            r#"{"cli":{"type":"api_key","key":"sk-cli"}}"#,
        )
        .unwrap();

        assert_eq!(import_providers(&db, &secrets, &home).unwrap(), 1);
        let imported = list_providers(&db, &secrets, true).unwrap();
        assert!(imported
            .iter()
            .any(|p| p.vendor_key == "cli" && p.has_secret));
        assert_eq!(
            import_providers(&db, &secrets, &home).unwrap(),
            0,
            "second import is idempotent"
        );

        let desktop = create_provider(
            &db,
            &secrets,
            ProviderCreateInput {
                name: "Desktop only".into(),
                vendor_key: Some("desktop".into()),
                provider_type: Some("openai_compatible".into()),
                protocol: Some("openai_compatible".into()),
                base_url: Some("https://desktop/v1".into()),
                auth_kind: Some("api_key_and_base_url".into()),
                models: Some(serde_json::from_value(json!([{ "id": "desk-model" }])).unwrap()),
                default_model_id: None,
                secret_value: Some("sk-desktop".into()),
                api_style: Some("openai_completions".into()),
                oauth_account_label: None,
                headers: None,
                supports_reasoning: None,
                supported_thinking_levels: None,
                context_window: None,
                max_output_tokens: None,
                temperature: None,
            },
        )
        .unwrap();
        assert!(export_providers(&db, &secrets, &home).unwrap() >= 2);
        let models = read_json(&home.join(MODELS_FILE));
        assert!(models["providers"].get(&desktop.id).is_some());
        assert_eq!(models["providers"][&desktop.id]["name"], "Desktop only");
        assert!(
            models["providers"].get("cli").is_some(),
            "CLI-only provider stays"
        );
        let auth = read_json(&home.join(AUTH_FILE));
        assert_eq!(auth[&desktop.id]["key"], "sk-desktop");
        assert_eq!(auth["cli"]["key"], "sk-cli");

        delete_provider(&db, &secrets, &desktop.id).unwrap();
        export_providers(&db, &secrets, &home).unwrap();
        let models = read_json(&home.join(MODELS_FILE));
        assert!(
            models["providers"].get(&desktop.id).is_none(),
            "deleted provider removed once"
        );
        assert!(models["providers"].get("cli").is_some());
        let _ = fs::remove_dir_all(dir.path());
    }
    #[test]
    fn api_style_round_trips_pi_names() {
        assert_eq!(
            api_style_from_pi(Some("openai-completions")),
            "openai_completions"
        );
        assert_eq!(
            api_style_from_pi(Some("openai-responses")),
            "openai_responses"
        );
        assert_eq!(
            api_style_from_pi(Some("anthropic-messages")),
            "anthropic_messages"
        );
        assert_eq!(
            pi_api_from_style(Some("openai_completions"), None),
            "openai-completions"
        );
        assert_eq!(
            pi_api_from_style(None, Some("anthropic")),
            "anthropic-messages"
        );
    }
}
