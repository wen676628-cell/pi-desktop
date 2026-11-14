use super::*;

impl PluginManager {
    fn valid_review_token(token: &str) -> bool {
        token.len() == 36
            && token
                .chars()
                .all(|value| value.is_ascii_hexdigit() || value == '-')
    }

    /// Validate a review token and return its private staging directory.
    fn review_stage(&self, token: &str) -> Result<PathBuf> {
        if !Self::valid_review_token(token) {
            bail!("PLUGIN_REVIEW_INVALID: review token is not valid");
        }
        let stage = self.review_dir(token);
        if !stage.is_dir() {
            bail!("PLUGIN_REVIEW_EXPIRED: review is no longer available");
        }
        Ok(stage)
    }

    /// Copy or extract a local plugin into the review's private directory.
    fn stage_review_content(&self, source: &Path, stage: &Path) -> Result<PathBuf> {
        if source.is_dir() {
            let plugin = stage.join("plugin");
            copy_dir_filtered(source, &plugin)?;
            return Ok(plugin);
        }
        let bytes =
            fs::read(source).with_context(|| format!("read package {}", source.display()))?;
        if bytes.len() as u64 > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        let extract_dir = stage.join("extract");
        fs::create_dir_all(&extract_dir)?;
        extract_zip_bytes(&bytes, &extract_dir)?;
        let root = find_plugin_root(&extract_dir)?;
        let plugin = stage.join("plugin");
        if root != plugin {
            fs::rename(&root, &plugin)?;
        }
        Ok(plugin)
    }

    /// Stage a local folder or package and describe what it asks for.
    ///
    /// Choosing a file is a request, not consent: this reads and extracts the
    /// bytes, but registers nothing and leaves any installed version alone.
    pub fn review_install(&mut self, source_path: &str) -> Result<InstallReview> {
        let source = PathBuf::from(source_path);
        if !source.exists() {
            bail!("PLUGIN_INVALID: package path missing");
        }
        let token = uuid::Uuid::new_v4().to_string();
        let stage = self.review_dir(&token);
        fs::create_dir_all(&stage)?;
        let result = (|| -> Result<InstallReview> {
            let plugin_root = self.stage_review_content(&source, &stage)?;
            let manifest = Self::read_manifest(&plugin_root)?;
            let existing = self.get(&manifest.id);
            let added_permissions = manifest
                .permissions
                .iter()
                .filter(|permission| {
                    existing
                        .as_ref()
                        .map(|plugin| !plugin.permissions.contains(permission))
                        .unwrap_or(true)
                })
                .cloned()
                .collect();
            let upgraded = existing
                .as_ref()
                .map(|plugin| plugin.version != manifest.version)
                .unwrap_or(false);
            Ok(InstallReview {
                review_token: token.clone(),
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                version: manifest.version.clone(),
                permissions: manifest.permissions.clone(),
                added_permissions,
                upgraded,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        result
    }

    /// Install exactly the bytes the user reviewed for this token.
    pub fn install_from_review(
        &mut self,
        review_token: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        let stage = self.review_stage(review_token)?;
        let plugin_root = stage.join("plugin");
        if !plugin_root.is_dir() {
            let _ = fs::remove_dir_all(&stage);
            bail!("PLUGIN_REVIEW_EXPIRED: review content is missing");
        }
        let result = self.install_from_path(&plugin_root.to_string_lossy(), opts);
        let _ = fs::remove_dir_all(&stage);
        result
    }

    /// Drop a review the user declined.
    pub fn cancel_install_review(&self, review_token: &str) -> Result<bool> {
        if !Self::valid_review_token(review_token) {
            bail!("PLUGIN_REVIEW_INVALID: review token is not valid");
        }
        let stage = self.review_dir(review_token);
        if !stage.exists() {
            return Ok(false);
        }
        fs::remove_dir_all(&stage)?;
        Ok(true)
    }
}
