//! Single owner for the pi home configuration files.
//!
//! Desktop and the pi CLI share `PI_HOME` (`PI_CODING_AGENT_DIR`, else
//! `~/.pi/agent`). `models.json` describes providers and models, `auth.json`
//! holds API keys, `settings.json` holds non-secret pi settings. This module is
//! the only host code allowed to read or write those files; provider RPCs go
//! through it so a Desktop edit and a CLI edit converge on one file set.

use crate::db::Database;
use crate::providers::{
    create_provider_with_id, get_provider, get_secret_for_provider, list_providers,
    set_provider_secret, update_provider, ModelBinding, ProviderCreateInput, ProviderPublic,
    ProviderUpdateInput, SecretStore, CANONICAL_THINKING_LEVELS, DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_TOKENS,
};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
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

/// Which ids the Desktop may remove from the shared files. `imported` records
/// CLI-owned providers the Desktop merely mirrors; they are never deleted from
/// `models.json`, even when the Desktop row goes away.
#[derive(Default)]
struct Manifest {
    managed: BTreeSet<String>,
    imported: BTreeSet<String>,
}

impl Manifest {
    fn read(home: &Path) -> Self {
        let value = read_json(&home.join(MANIFEST_FILE));
        let ids = |key: &str| -> BTreeSet<String> {
            value
                .get(key)
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            managed: ids("managed"),
            imported: ids("imported"),
        }
    }
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
        "google-generative-ai" | "google_generative_ai" => "google_generative_ai",
        "openai-codex-responses" | "openai_codex_responses" => "openai_codex_responses",
        "pi-messages" | "pi_messages" => "pi_messages",
        "opencode-go" | "opencode_go" => "opencode_go",
        _ => "openai_completions",
    }
    .to_string()
}

/// Whether the Desktop runtime can speak this pi wire API. Importing a provider
/// it cannot (Bedrock, Mistral, Azure, Vertex) as OpenAI-compatible would create
/// a row whose requests fail; the provider stays CLI-only instead.
fn pi_api_importable(value: Option<&str>) -> bool {
    !matches!(
        value
            .unwrap_or("openai-completions")
            .to_ascii_lowercase()
            .as_str(),
        "mistral-conversations"
            | "bedrock-converse-stream"
            | "azure-openai-responses"
            | "google-vertex"
            | "google_vertex"
    )
}

fn pi_api_from_style(value: Option<&str>, protocol: Option<&str>) -> &'static str {
    match value.unwrap_or("").to_ascii_lowercase().as_str() {
        "openai_responses" | "openai-responses" | "responses" => "openai-responses",
        "anthropic_messages" | "anthropic-messages" | "anthropic" => "anthropic-messages",
        "google_generative_ai" | "google-generative-ai" => "google-generative-ai",
        "openai_codex_responses" | "openai-codex-responses" => "openai-codex-responses",
        "pi_messages" | "pi-messages" => "pi-messages",
        "opencode_go" | "opencode-go" => "opencode-go",
        _ => match protocol.unwrap_or("").to_ascii_lowercase().as_str() {
            "responses" => "openai-responses",
            "anthropic" => "anthropic-messages",
            _ => "openai-completions",
        },
    }
}

fn model_row_id(row: &Value) -> Option<&str> {
    row.as_str()
        .or_else(|| row.get("id").and_then(Value::as_str))
}

fn model_bindings(record: &Value) -> Option<Vec<ModelBinding>> {
    let rows = record.get("models")?.as_array()?;
    let api = record
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    let models: Vec<ModelBinding> = rows
        .iter()
        .filter_map(|row| model_binding(row, api))
        .collect();
    (!models.is_empty()).then_some(models)
}

/// One `models.json` model row. The CLI keeps context window, output limit,
/// thinking capability and modalities on the model record; the Desktop binding
/// is where the runtime reads them, so dropping them here would cap output at
/// the generic seed and hide every thinking level the provider publishes.
fn model_binding(row: &Value, api: &str) -> Option<ModelBinding> {
    let id = model_row_id(row)?.to_string();
    let mut binding: ModelBinding = serde_json::from_value(json!({ "id": id })).ok()?;
    if row.is_string() {
        return Some(binding);
    }
    let alias = row
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != binding.id.as_str())
        .map(str::to_string);
    binding.alias = alias;
    // Imported limits come from the user's own CLI config, so they are marked
    // `user`: a published catalog correction must not overwrite them.
    if let Some(context_window) = row.get("contextWindow").and_then(Value::as_u64) {
        if context_window > 0 {
            binding.context_window = context_window.min(u64::from(u32::MAX)) as u32;
            binding.context_window_source = Some("user".into());
        }
    }
    if let Some(max_tokens) = row.get("maxTokens").and_then(Value::as_u64) {
        if max_tokens > 0 {
            binding.max_tokens = max_tokens.min(u64::from(u32::MAX)) as u32;
            binding.max_tokens_source = Some("user".into());
        }
    }
    binding.thinking_levels = thinking_levels_from(row);
    if !binding.thinking_levels.is_empty() && !binding.thinking_levels.iter().any(|l| l == "off") {
        // `off` is never a wire value, so it is always selectable: without it
        // the runtime clamps a disabled session to the first enabled level and
        // the provider starts reasoning anyway.
        binding.thinking_levels.insert(0, "off".to_string());
    }
    if !binding.thinking_levels.is_empty() {
        // Only the OpenAI wire sends thinking as `reasoning_effort`; Anthropic
        // and Google rows carry their own protocol.
        binding.supports_reasoning_effort = api.starts_with("openai").then_some(true);
    }
    if let Some(input) = row.get("input").and_then(Value::as_array) {
        let accepts = |name: &str| input.iter().any(|value| value.as_str() == Some(name));
        binding.supports_images = accepts("image").then_some(true);
        binding.supports_documents = accepts("document").then_some(true);
    }
    Some(binding)
}

fn thinking_levels_from(row: &Value) -> Vec<String> {
    let canonical: Vec<&str> = CANONICAL_THINKING_LEVELS.to_vec();
    if let Some(map) = row.get("thinkingLevelMap").and_then(Value::as_object) {
        return canonical
            .into_iter()
            .filter(|level| map.get(*level).is_some_and(|value| !value.is_null()))
            .map(str::to_string)
            .collect();
    }
    let Some(listed) = row.get("thinkingLevels").and_then(Value::as_array) else {
        return Vec::new();
    };
    canonical
        .into_iter()
        .filter(|level| listed.iter().any(|value| value.as_str() == Some(*level)))
        .map(str::to_string)
        .collect()
}

/// Resolve a `models.json` provider `apiKey` the way the Desktop importer
/// (`packages/shared/src/model-config-import.ts`) does: `env:NAME` and
/// `{env:NAME}` read this process's environment, `$NAME` and `!command`
/// references stay unstored, and literals pass through.
fn models_json_secret(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('!') {
        return None;
    }
    let referenced = trimmed
        .strip_prefix("env:")
        .map(|name| name.trim().to_string())
        .or_else(|| {
            trimmed
                .strip_prefix("{env:")
                .and_then(|rest| rest.strip_suffix('}'))
                .map(|name| name.trim().to_string())
        });
    if let Some(name) = referenced {
        if name.is_empty() {
            return None;
        }
        return env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    (!is_placeholder_secret(trimmed)).then(|| trimmed.to_string())
}

fn is_placeholder_secret(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix('$') {
        let name = rest
            .strip_prefix('{')
            .and_then(|inner| inner.strip_suffix('}'))
            .unwrap_or(rest);
        let mut chars = name.chars();
        if chars
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false)
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return true;
        }
    }
    let compact: String = value
        .to_ascii_lowercase()
        .chars()
        .filter(|c| *c != '_' && *c != '-')
        .collect();
    compact.contains("yourapikey")
        || compact == "changeme"
        || (!value.is_empty() && value.chars().all(|c| c == 'x' || c == 'X'))
}

/// Non-secret provider headers travel with the shared config; anything that
/// carries a credential stays on the CLI side instead of landing in SQLite.
fn importable_headers(record: &Value) -> Option<BTreeMap<String, String>> {
    let headers = record.get("headers")?.as_object()?;
    let kept: BTreeMap<String, String> = headers
        .iter()
        .filter(|(name, _)| !header_is_secret(name))
        .filter_map(|(name, value)| {
            value
                .as_str()
                .map(|value| (name.clone(), value.to_string()))
        })
        .collect();
    (!kept.is_empty()).then_some(kept)
}

fn header_is_secret(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "api-key",
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Import providers that exist only in the CLI files into SQLite.
///
/// Matching is by `vendor_key == models.json provider id`. Existing rows are
/// kept as they are, except that a row holding no credential gains the one the
/// CLI files carry. Returns how many rows were created.
pub fn import_providers(db: &Database, secrets: &SecretStore, home: &Path) -> Result<usize> {
    let models = read_json(&home.join(MODELS_FILE));
    let auth = read_json(&home.join(AUTH_FILE));
    let Some(map) = models.get("providers").and_then(Value::as_object) else {
        return Ok(0);
    };
    let existing = list_providers(db, secrets, true)?;
    let mut imported = 0;
    for (id, record) in map {
        if !pi_api_importable(record.get("api").and_then(Value::as_str)) {
            continue;
        }
        // `auth.json` owns stored credentials; the inline `apiKey` in
        // `models.json` is the other channel the CLI resolves, so Desktop has
        // to see it too or a CLI-only provider reads as keyless here.
        let secret = auth
            .get(id)
            .and_then(|entry| entry.get("key").or_else(|| entry.get("apiKey")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                record
                    .get("apiKey")
                    .or_else(|| record.get("api_key"))
                    .and_then(Value::as_str)
                    .and_then(models_json_secret)
            });
        if let Some(row) = existing.iter().find(|p| p.vendor_key == *id) {
            // Backfill a row imported before its key existed. A row that
            // already holds a credential keeps it untouched.
            if !row.has_secret {
                if let Some(secret) = secret {
                    set_provider_secret(db, secrets, &row.id, Some(&secret))?;
                }
            }
            backfill_model_metadata(db, secrets, row, record)?;
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
            headers: importable_headers(record),
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

/// Refresh limits and thinking capability of a row imported before the CLI
/// metadata reached its bindings. The provenance markers are how a Desktop edit
/// says "this number is mine", so only untouched limits follow the CLI config.
fn backfill_model_metadata(
    db: &Database,
    secrets: &SecretStore,
    provider: &ProviderPublic,
    record: &Value,
) -> Result<()> {
    let mut models = provider.models.clone();
    let mut models_changed = false;
    if let Some(cli_models) = model_bindings(record) {
        for model in &mut models {
            let Some(cli) = cli_models.iter().find(|candidate| candidate.id == model.id) else {
                continue;
            };
            if model.context_window_source.is_none() && cli.context_window > 0 {
                model.context_window = cli.context_window;
                model.context_window_source = cli.context_window_source.clone();
                models_changed = true;
            }
            if model.max_tokens_source.is_none() && cli.max_tokens > 0 {
                model.max_tokens = cli.max_tokens;
                model.max_tokens_source = cli.max_tokens_source.clone();
                models_changed = true;
            }
            // Adopt the CLI's levels when the stored set is a subset of them:
            // this adds `off` and newly published levels without dropping a
            // level the user added on the Desktop side.
            if !cli.thinking_levels.is_empty()
                && model.thinking_levels != cli.thinking_levels
                && model
                    .thinking_levels
                    .iter()
                    .all(|level| cli.thinking_levels.contains(level))
            {
                model.thinking_levels = cli.thinking_levels.clone();
                model.supports_reasoning_effort = cli.supports_reasoning_effort;
                models_changed = true;
            }
            if model.supports_images.is_none() && cli.supports_images.is_some() {
                model.supports_images = cli.supports_images;
                models_changed = true;
            }
        }
    }
    let headers = if provider.headers.is_none() {
        importable_headers(record)
    } else {
        None
    };
    if !models_changed && headers.is_none() {
        return Ok(());
    }
    update_provider(
        db,
        secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: None,
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: None,
            models: models_changed.then_some(models),
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers,
            supports_reasoning: None,
            supported_thinking_levels: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            enabled: None,
        },
    )?;
    Ok(())
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
    let manifest = Manifest::read(home);
    // Provider ids the CLI file already describes. A row whose id equals its
    // vendor key there mirrors the CLI's provider instead of being one this
    // Desktop introduced, so a Desktop delete may not remove it.
    let file_ids: BTreeSet<String> = models
        .get("providers")
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    let mut current_managed = BTreeSet::new();
    let mut current_imported = manifest.imported.clone();
    let mut exported = 0;

    for provider in &providers {
        if provider.owner_plugin_id.is_some() {
            continue;
        }
        if provider.vendor_key == provider.id && file_ids.contains(&provider.id) {
            current_imported.insert(provider.id.clone());
        } else {
            current_managed.insert(provider.id.clone());
        }
        let mut entry = json!({
            "name": provider.name,
            "baseUrl": provider.base_url,
            "api": pi_api_from_style(provider.api_style.as_deref(), Some(&provider.protocol)),
            "models": exported_model_rows(&models, &provider.id, &provider.models),
            "headers": provider.headers,
        });
        // Desktop cannot name every pi wire API (Bedrock, Mistral, Vertex), so
        // a file that already states one keeps it: rewriting the provider it
        // merely imported would break the CLI's own requests.
        let file_states_api = models
            .get("providers")
            .and_then(|providers| providers.get(&provider.id))
            .and_then(|record| record.get("api"))
            .is_some();
        if file_states_api {
            if let Some(fields) = entry.as_object_mut() {
                fields.remove("api");
            }
        }
        // Per-key merge: the file may carry credential headers this Desktop
        // never imported, and a blind replace would erase them.
        if let Some(db_headers) = provider.headers.as_ref() {
            let mut merged = models
                .get("providers")
                .and_then(|providers| providers.get(&provider.id))
                .and_then(|record| record.get("headers"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (name, value) in db_headers {
                merged.insert(name.clone(), Value::String(value.clone()));
            }
            if let Some(fields) = entry.as_object_mut() {
                fields.insert("headers".into(), Value::Object(merged));
            }
        }
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

    for stale in manifest
        .managed
        .iter()
        .filter(|id| !current_managed.contains(*id))
    {
        // An id the CLI owns is never removed, even if an older Desktop build
        // recorded it as managed.
        if current_imported.contains(stale) {
            continue;
        }
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
        serde_json::to_vec_pretty(&json!({
            "managed": current_managed,
            "imported": current_imported,
        }))?
        .as_slice(),
    )?;
    Ok(exported)
}

/// The non-secret settings both surfaces own. Everything else in
/// `settings.json` (theme, packages, retry policy, …) belongs to the CLI and is
/// never rewritten from the Desktop store.
const APP_SETTINGS_KEY: &str = "app";
const SHARED_COMPACTION_KEYS: [&str; 3] = ["enabled", "reserveTokens", "keepRecentTokens"];

/// Pull the shared settings from `settings.json` into the Desktop store.
///
/// The default model is adopted only when this Desktop actually has that
/// provider row and model binding, so a CLI default the runtime cannot serve
/// never becomes the Desktop default.
pub fn import_settings(db: &Database, secrets: &SecretStore, home: &Path) -> Result<usize> {
    let file = read_json(&home.join(SETTINGS_FILE));
    let mut settings = db
        .get_setting(APP_SETTINGS_KEY)?
        .unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        settings = json!({});
    }
    let mut changes = 0;
    if let (Some(provider_id), Some(model_id)) = (
        file.get("defaultProvider").and_then(Value::as_str),
        file.get("defaultModel").and_then(Value::as_str),
    ) {
        let known = get_provider(db, secrets, provider_id)?
            .is_some_and(|provider| provider.models.iter().any(|model| model.id == model_id));
        if known {
            if settings.get("defaultProviderId").and_then(Value::as_str) != Some(provider_id) {
                settings["defaultProviderId"] = json!(provider_id);
                changes += 1;
            }
            if settings.get("defaultModelId").and_then(Value::as_str) != Some(model_id) {
                settings["defaultModelId"] = json!(model_id);
                changes += 1;
            }
        }
    }
    if let Some(compaction) = file.get("compaction").and_then(Value::as_object) {
        let mut merged = settings
            .get("contextCompaction")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(|| {
                // A fresh Desktop store still needs a complete section: the
                // runtime reads these three numbers directly.
                json!({
                    "enabled": true,
                    "reserveTokens": 16384,
                    "keepRecentTokens": 20000,
                })
                .as_object()
                .cloned()
                .unwrap_or_default()
            });
        for key in SHARED_COMPACTION_KEYS {
            if let Some(value) = compaction.get(key) {
                if merged.get(key) != Some(value) {
                    merged.insert(key.to_string(), value.clone());
                    changes += 1;
                }
            }
        }
        if let Some(fields) = settings.as_object_mut() {
            fields.insert("contextCompaction".into(), Value::Object(merged));
        }
    }
    if changes > 0 {
        db.set_setting(APP_SETTINGS_KEY, &settings)?;
    }
    Ok(changes)
}

/// Publish the shared settings back to `settings.json`, preserving every
/// CLI-only key already in that file.
pub fn export_settings(db: &Database, home: &Path) -> Result<usize> {
    let Some(settings) = db.get_setting(APP_SETTINGS_KEY)? else {
        return Ok(0);
    };
    let path = home.join(SETTINGS_FILE);
    let mut file = read_json(&path);
    if !file.is_object() {
        file = json!({});
    }
    let mut changes = 0;
    if let (Some(provider_id), Some(model_id)) = (
        settings.get("defaultProviderId").and_then(Value::as_str),
        settings.get("defaultModelId").and_then(Value::as_str),
    ) {
        if file.get("defaultProvider").and_then(Value::as_str) != Some(provider_id) {
            file["defaultProvider"] = json!(provider_id);
            changes += 1;
        }
        if file.get("defaultModel").and_then(Value::as_str) != Some(model_id) {
            file["defaultModel"] = json!(model_id);
            changes += 1;
        }
    }
    if let Some(compaction) = settings.get("contextCompaction").and_then(Value::as_object) {
        let mut merged = file
            .get("compaction")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in SHARED_COMPACTION_KEYS {
            if let Some(value) = compaction.get(key) {
                if merged.get(key) != Some(value) {
                    merged.insert(key.to_string(), value.clone());
                    changes += 1;
                }
            }
        }
        if let Some(fields) = file.as_object_mut() {
            fields.insert("compaction".into(), Value::Object(merged));
        }
    }
    if changes > 0 {
        atomic_write(&path, serde_json::to_vec_pretty(&file)?.as_slice())?;
    }
    Ok(changes)
}

/// Model rows to write back to `models.json`. A Desktop export must not erase
/// the CLI's per-model fields (limits, thinking map, modalities), so any row the
/// shared file already describes is kept and only missing keys are filled from
/// the binding. A model the file has never seen is written as an object with
/// the limits the Desktop actually uses, so the CLI does not fall back to the
/// generic seed.
fn exported_model_rows(models: &Value, provider_id: &str, bindings: &[ModelBinding]) -> Vec<Value> {
    let existing = models
        .get("providers")
        .and_then(|providers| providers.get(provider_id))
        .and_then(|record| record.get("models"))
        .and_then(Value::as_array);
    bindings
        .iter()
        .map(|binding| {
            let current = existing.and_then(|rows| {
                rows.iter()
                    .find(|row| model_row_id(row) == Some(binding.id.as_str()))
            });
            let mut row = match current {
                Some(Value::Object(map)) => map.clone(),
                Some(Value::String(id)) => {
                    let mut map = Map::new();
                    map.insert("id".into(), Value::String(id.clone()));
                    map
                }
                Some(other) => return other.clone(),
                None => {
                    let mut map = Map::new();
                    map.insert("id".into(), Value::String(binding.id.clone()));
                    map
                }
            };
            fill_model_row(&mut row, binding);
            Value::Object(row)
        })
        .collect()
}

/// Fill the keys the file does not state yet. Existing values always win: they
/// may come from the CLI's own richer record or from an older Desktop export.
fn fill_model_row(row: &mut Map<String, Value>, binding: &ModelBinding) {
    let user_context = binding.context_window_source.as_deref() == Some("user");
    let user_max = binding.max_tokens_source.as_deref() == Some("user");
    if !row.contains_key("contextWindow")
        && (user_context || binding.context_window != DEFAULT_CONTEXT_WINDOW)
    {
        row.insert("contextWindow".into(), json!(binding.context_window));
    }
    if !row.contains_key("maxTokens") && (user_max || binding.max_tokens != DEFAULT_MAX_TOKENS) {
        row.insert("maxTokens".into(), json!(binding.max_tokens));
    }
    if !row.contains_key("thinkingLevelMap") {
        let levels: Map<String, Value> = binding
            .thinking_levels
            .iter()
            .filter(|level| level.as_str() != "off")
            .map(|level| (level.clone(), json!(level)))
            .collect();
        if !levels.is_empty() {
            row.insert("thinkingLevelMap".into(), Value::Object(levels));
        }
    }
    if !row.contains_key("input") && binding.supports_images == Some(true) {
        row.insert("input".into(), json!(["text", "image"]));
    }
    if !row.contains_key("name") {
        if let Some(alias) = binding.alias.as_deref() {
            row.insert("name".into(), json!(alias));
        }
    }
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
    fn imports_inline_models_json_api_key_and_backfills_a_missing_secret() {
        use crate::db::Database;
        use crate::providers::{list_providers, SecretStore};

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        fs::write(
            home.join(MODELS_FILE),
            r#"{"providers":{"gateway":{"name":"gateway","baseUrl":"https://cli/v1","api":"openai-completions","apiKey":"sk-inline","models":[{"id":"cli-model"}]}}}"#,
        )
        .unwrap();
        fs::write(home.join(AUTH_FILE), r#"{}"#).unwrap();

        assert_eq!(import_providers(&db, &secrets, &home).unwrap(), 1);
        let imported = list_providers(&db, &secrets, true).unwrap();
        let row = imported.iter().find(|p| p.vendor_key == "gateway").unwrap();
        assert!(row.has_secret, "inline models.json apiKey is a credential");
        assert_eq!(
            get_secret_for_provider(&db, &secrets, &row.id)
                .unwrap()
                .as_deref(),
            Some("sk-inline")
        );

        // A row imported before the key existed is backfilled, not duplicated.
        let id = row.id.clone();
        set_provider_secret(&db, &secrets, &id, None).unwrap();
        assert_eq!(import_providers(&db, &secrets, &home).unwrap(), 0);
        let rows = list_providers(&db, &secrets, true).unwrap();
        let matched: Vec<_> = rows.iter().filter(|p| p.vendor_key == "gateway").collect();
        assert_eq!(matched.len(), 1);
        assert!(matched[0].has_secret, "backfilled on the next import pass");
        let _ = fs::remove_dir_all(dir.path());
    }

    #[test]
    fn imports_model_limits_thinking_and_keeps_them_on_export() {
        use crate::db::Database;
        use crate::providers::{list_providers, SecretStore};

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        fs::write(
            home.join(MODELS_FILE),
            r#"{"providers":{"gateway":{"name":"gateway","baseUrl":"https://cli/v1","api":"openai-completions","apiKey":"sk-inline","headers":{"HTTP-Referer":"https://cli","Authorization":"Bearer test-token"},"models":[{"id":"cli-model","name":"CLI Model","contextWindow":1000000,"maxTokens":128000,"thinkingLevelMap":{"low":"low","high":"high","medium":null},"input":["text","image"]}]}}}"#,
        )
        .unwrap();
        fs::write(home.join(AUTH_FILE), r#"{}"#).unwrap();

        assert_eq!(import_providers(&db, &secrets, &home).unwrap(), 1);
        let imported = list_providers(&db, &secrets, true).unwrap();
        let row = imported
            .into_iter()
            .find(|p| p.vendor_key == "gateway")
            .unwrap();
        let model = &row.models[0];
        assert_eq!(model.context_window, 1_000_000);
        assert_eq!(model.max_tokens, 128_000);
        assert_eq!(
            model.thinking_levels,
            vec!["off".to_string(), "low".to_string(), "high".to_string()]
        );
        assert_eq!(model.supports_reasoning_effort, Some(true));
        assert_eq!(model.supports_images, Some(true));
        assert_eq!(model.alias.as_deref(), Some("CLI Model"));
        assert_eq!(
            row.headers
                .as_ref()
                .and_then(|headers| headers.get("HTTP-Referer"))
                .map(String::as_str),
            Some("https://cli")
        );
        assert!(
            row.headers
                .as_ref()
                .map(|headers| !headers.contains_key("Authorization"))
                .unwrap_or(true),
            "credential headers stay on the CLI side"
        );

        // A row imported before the metadata reached its bindings is refreshed.
        let legacy: ModelBinding = serde_json::from_value(json!({ "id": "cli-model" })).unwrap();
        update_provider(
            &db,
            &secrets,
            ProviderUpdateInput {
                id: row.id.clone(),
                name: None,
                vendor_key: None,
                provider_type: None,
                protocol: None,
                base_url: None,
                auth_kind: None,
                models: Some(vec![legacy]),
                default_model_id: None,
                secret_value: None,
                api_style: None,
                oauth_account_label: None,
                headers: None,
                supports_reasoning: None,
                supported_thinking_levels: None,
                context_window: None,
                max_output_tokens: None,
                temperature: None,
                enabled: None,
            },
        )
        .unwrap();
        assert_eq!(import_providers(&db, &secrets, &home).unwrap(), 0);
        let refreshed = list_providers(&db, &secrets, true)
            .unwrap()
            .into_iter()
            .find(|p| p.vendor_key == "gateway")
            .unwrap();
        assert_eq!(refreshed.models[0].context_window, 1_000_000);
        assert_eq!(refreshed.models[0].max_tokens, 128_000);
        assert_eq!(refreshed.models[0].thinking_levels.len(), 3);

        // A Desktop export keeps the CLI's richer model rows.
        export_providers(&db, &secrets, &home).unwrap();
        let models = read_json(&home.join(MODELS_FILE));
        assert_eq!(
            models["providers"]["gateway"]["models"][0]["maxTokens"],
            128_000
        );
        assert_eq!(
            models["providers"]["gateway"]["models"][0]["contextWindow"],
            1_000_000
        );
        assert_eq!(
            models["providers"]["gateway"]["headers"]["Authorization"], "Bearer test-token",
            "export keeps credential headers it never imported"
        );
        assert_eq!(
            models["providers"]["gateway"]["headers"]["HTTP-Referer"],
            "https://cli"
        );
        let _ = fs::remove_dir_all(dir.path());
    }

    #[test]
    fn export_writes_limits_and_preserves_the_cli_api() {
        use crate::db::Database;
        use crate::providers::{create_provider, SecretStore};

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        // A CLI provider whose wire API the Desktop cannot name: an export must
        // leave its `api` alone rather than rewrite it to OpenAI-compatible.
        fs::write(
            home.join(MODELS_FILE),
            r#"{"providers":{"bedrockish":{"name":"Bedrock","baseUrl":"https://bedrock/v1","api":"bedrock-converse-stream","models":[{"id":"m1"}]}}}"#,
        )
        .unwrap();
        fs::write(home.join(AUTH_FILE), r#"{}"#).unwrap();
        assert_eq!(import_providers(&db, &secrets, &home).unwrap(), 0);

        // A Desktop-created provider publishes the limits the runtime uses.
        let binding: ModelBinding = serde_json::from_value(json!({
            "id": "desk-model",
            "contextWindow": 500000,
            "contextWindowSource": "user",
            "maxTokens": 32000,
            "maxTokensSource": "user",
            "thinkingLevels": ["off", "high"],
            "supportsReasoningEffort": true,
            "supportsImages": true
        }))
        .unwrap();
        let created = create_provider(
            &db,
            &secrets,
            ProviderCreateInput {
                name: "Desk".into(),
                vendor_key: Some("desk".into()),
                provider_type: Some("openai_compatible".into()),
                protocol: Some("openai_compatible".into()),
                base_url: Some("https://desk/v1".into()),
                auth_kind: Some("api_key_and_base_url".into()),
                models: Some(vec![binding]),
                default_model_id: None,
                secret_value: Some("sk-desk".into()),
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
        export_providers(&db, &secrets, &home).unwrap();
        let models = read_json(&home.join(MODELS_FILE));
        assert_eq!(
            models["providers"]["bedrockish"]["api"],
            "bedrock-converse-stream"
        );
        let row = &models["providers"][created.id.as_str()]["models"][0];
        assert_eq!(row["contextWindow"], 500_000);
        assert_eq!(row["maxTokens"], 32_000);
        assert_eq!(row["thinkingLevelMap"]["high"], "high");
        assert!(row["thinkingLevelMap"].get("off").is_none());
        assert_eq!(row["input"][1], "image");

        let _ = fs::remove_dir_all(dir.path());
    }

    #[test]
    fn cli_owned_providers_survive_a_desktop_delete() {
        use crate::db::Database;
        use crate::providers::{delete_provider, list_providers, SecretStore};

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        fs::write(
            home.join(MODELS_FILE),
            r#"{"providers":{"cli":{"name":"CLI","baseUrl":"https://cli/v1","api":"openai-completions","models":[{"id":"m1"}]}}}"#,
        )
        .unwrap();
        fs::write(home.join(AUTH_FILE), r#"{}"#).unwrap();

        import_providers(&db, &secrets, &home).unwrap();
        export_providers(&db, &secrets, &home).unwrap();
        let manifest = Manifest::read(&home);
        assert!(manifest.imported.contains("cli"));
        assert!(!manifest.managed.contains("cli"));

        let row = list_providers(&db, &secrets, true)
            .unwrap()
            .into_iter()
            .find(|p| p.vendor_key == "cli")
            .unwrap();
        delete_provider(&db, &secrets, &row.id).unwrap();
        export_providers(&db, &secrets, &home).unwrap();
        let models = read_json(&home.join(MODELS_FILE));
        assert!(
            models["providers"].get("cli").is_some(),
            "a Desktop delete never removes a CLI-owned provider from the shared file"
        );
        let _ = fs::remove_dir_all(dir.path());
    }

    #[test]
    fn settings_sync_in_both_directions() {
        use crate::db::Database;
        use crate::providers::{create_provider_with_id, SecretStore};

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        db.set_setting("app", &json!({ "defaultMode": "agent" }))
            .unwrap();
        let binding: ModelBinding = serde_json::from_value(json!({ "id": "m1" })).unwrap();
        create_provider_with_id(
            &db,
            &secrets,
            "cli",
            ProviderCreateInput {
                name: "CLI".into(),
                vendor_key: Some("cli".into()),
                provider_type: Some("openai_compatible".into()),
                protocol: Some("openai_compatible".into()),
                base_url: Some("https://cli/v1".into()),
                auth_kind: Some("api_key_and_base_url".into()),
                models: Some(vec![binding]),
                default_model_id: None,
                secret_value: Some("sk-cli".into()),
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

        fs::write(
            home.join(SETTINGS_FILE),
            r#"{"defaultProvider":"cli","defaultModel":"m1","compaction":{"enabled":false,"reserveTokens":4096},"theme":"dark"}"#,
        )
        .unwrap();
        assert!(import_settings(&db, &secrets, &home).unwrap() >= 3);
        let settings = db.get_setting("app").unwrap().unwrap();
        assert_eq!(settings["defaultProviderId"], "cli");
        assert_eq!(settings["defaultModelId"], "m1");
        assert_eq!(settings["contextCompaction"]["enabled"], false);
        assert_eq!(settings["contextCompaction"]["reserveTokens"], 4096);

        // A model this Desktop does not serve never becomes its default.
        fs::write(
            home.join(SETTINGS_FILE),
            r#"{"defaultProvider":"cli","defaultModel":"nope"}"#,
        )
        .unwrap();
        db.set_setting(
            "app",
            &json!({ "defaultProviderId": "cli", "defaultModelId": "m1" }),
        )
        .unwrap();
        import_settings(&db, &secrets, &home).unwrap();
        assert_eq!(
            db.get_setting("app").unwrap().unwrap()["defaultModelId"],
            "m1"
        );

        // Desktop edits flow back out; CLI-only keys survive untouched.
        let mut settings = db.get_setting("app").unwrap().unwrap();
        settings["defaultModelId"] = json!("m2");
        settings["contextCompaction"] = json!({
            "enabled": true,
            "keepRecentTokens": 9000,
            "reserveTokens": 2048
        });
        db.set_setting("app", &settings).unwrap();
        fs::write(
            home.join(SETTINGS_FILE),
            r#"{"defaultProvider":"cli","defaultModel":"m1","theme":"dark","compaction":{"enabled":false,"reserveTokens":4096}}"#,
        )
        .unwrap();
        export_settings(&db, &home).unwrap();
        let file = read_json(&home.join(SETTINGS_FILE));
        assert_eq!(file["defaultModel"], "m2");
        assert_eq!(file["theme"], "dark");
        assert_eq!(file["compaction"]["enabled"], true);
        assert_eq!(file["compaction"]["keepRecentTokens"], 9000);
        assert_eq!(file["compaction"]["reserveTokens"], 2048);
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
        assert_eq!(
            api_style_from_pi(Some("google-generative-ai")),
            "google_generative_ai"
        );
        assert_eq!(
            pi_api_from_style(Some("google_generative_ai"), None),
            "google-generative-ai"
        );
        assert_eq!(api_style_from_pi(Some("pi-messages")), "pi_messages");
        assert_eq!(
            api_style_from_pi(Some("openai-codex-responses")),
            "openai_codex_responses"
        );
        assert_eq!(api_style_from_pi(Some("opencode-go")), "opencode_go");
        assert!(!pi_api_importable(Some("bedrock-converse-stream")));
        assert!(pi_api_importable(Some("google-generative-ai")));
    }
}
