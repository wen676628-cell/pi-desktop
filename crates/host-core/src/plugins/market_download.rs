use super::*;

/// Everything a marketplace download needs, copied out of the manager so the
/// global `AppState` lock can be released while bytes move.
#[derive(Clone)]
pub(crate) struct MarketDownloadContext {
    data_dir: PathBuf,
    catalog_url: String,
    resolve: bool,
}

/// A catalog decision plus the context that can fetch it.
///
/// The plan is built under the state lock; fetching and installing use it
/// after the lock is released and reacquired.
#[derive(Clone)]
pub(crate) struct MarketInstallPlan {
    pub info: MarketDownloadInfo,
    pub marketplace: PluginMarketplaceMeta,
    pub download: MarketDownloadContext,
}

/// User decisions for publishing a fetched package.
#[derive(Clone)]
pub(crate) struct MarketInstallCommit {
    pub enable: bool,
    pub auto_update: bool,
    pub granted_permissions: Option<Vec<String>>,
}

impl PluginManager {
    /// Snapshot the channel and package location for one install.
    pub(crate) fn market_install_plan(
        &mut self,
        plugin_id: &str,
        version: Option<&str>,
    ) -> Result<MarketInstallPlan> {
        let info = self.market_download_info(plugin_id, version)?;
        let marketplace = PluginMarketplaceMeta {
            // The channel the bytes actually came from, so an installed row can
            // be told apart from one installed through another source.
            provider_id: self.channel().as_str().into(),
            shasum: None,
            // Record the publisher the catalog named. Falling back to the
            // project keeps registries written before publisher-owned sources
            // readable, but a v2 entry must not be relabelled as ours.
            publisher_id: Some(
                info.publisher_id
                    .clone()
                    .unwrap_or_else(|| "pi-desktop".into()),
            ),
            trust: info.trust.clone(),
            provenance: info.provenance.clone(),
        };
        Ok(MarketInstallPlan {
            info,
            marketplace,
            download: self.download_context(),
        })
    }

    fn download_context(&self) -> MarketDownloadContext {
        MarketDownloadContext {
            data_dir: self.data_dir.clone(),
            catalog_url: self.market_source_url(),
            resolve: self.uses_download_resolve(),
        }
    }

    /// Install a package that a plan already fetched.
    ///
    /// The caller may hold the state lock only for this step; the network and
    /// byte verification happened before it. Whatever happens, the cached
    /// package is removed.
    pub(crate) fn install_from_downloaded_market_package(
        &mut self,
        plan: &MarketInstallPlan,
        package_path: &Path,
        shasum: &str,
        commit: MarketInstallCommit,
        observer: &mut dyn InstallObserver,
    ) -> Result<InstallResult> {
        let mut report = DownloadReport::new(observer, &plan.info.plugin_id, &plan.info.version);
        // The last safe point: after this the package is being written into the
        // plugin directory, and stopping half way is worse than finishing.
        if report.cancelled() {
            let _ = fs::remove_file(package_path);
            return Err(report.failed(Vec::new(), anyhow!(super::progress::CANCELLED)));
        }
        report.phase(InstallPhase::Install);
        let mut marketplace = plan.marketplace.clone();
        marketplace.shasum = Some(shasum.to_string());
        let result = self.install_from_path(
            &package_path.to_string_lossy(),
            InstallOptions {
                source: "marketplace".into(),
                enable: commit.enable,
                marketplace: Some(marketplace),
                expected_shasum: Some(shasum.to_string()),
                auto_update: commit.auto_update,
                granted_permissions: commit.granted_permissions,
            },
        );
        let _ = fs::remove_file(package_path);
        if result.is_ok() {
            // The last thing an install does is make the plugin live; the
            // caller loads the renderer side of it after this returns.
            report.phase(InstallPhase::Enable);
        }
        result
    }
}

impl MarketDownloadContext {
    /// Fetch a package and verify its digest.
    pub(crate) fn fetch(
        &self,
        info: &MarketDownloadInfo,
        report: &mut DownloadReport<'_>,
    ) -> Result<(PathBuf, String)> {
        let mut tried: Vec<TriedMirror> = Vec::new();
        if self.resolve {
            report.phase(InstallPhase::Resolve);
            match self.download_via_resolve(info, report, &mut tried) {
                Ok(fetched) => return Ok(fetched),
                // Publication refusals and cancellations are authoritative:
                // never install through the catalog URL after either one.
                Err(error)
                    if !super::resolve::allows_catalog_fallback(&error)
                        || super::progress::is_cancelled(&error) =>
                {
                    return Err(report.failed(tried, error))
                }
                Err(error) => tracing::warn!(
                    plugin = %info.plugin_id,
                    version = %info.version,
                    %error,
                    "the plugin center resolve path is unavailable; using the catalog url"
                ),
            }
        }
        // The catalog's own URL avoids waiting for a slow resolve endpoint and
        // remains safe because `download` verifies its digest.
        report.phase(InstallPhase::Download);
        report.mirror(None, 0, 0);
        match self.download(info, &info.url, &info.shasum, info.size_bytes, report) {
            Ok(path) => Ok((path, info.shasum.clone())),
            Err(error) => Err(report.failed(tried, error)),
        }
    }

    /// Download through the plugin center's resolve interface.
    ///
    /// Every mirror the platform lists is tried in the order it gave: they are
    /// different hosts, and one can be unreachable, rate limited, or holding
    /// different bytes under the same version — which the digest catches before
    /// anything is extracted. The mirrors that failed are recorded in `tried`,
    /// which the terminal report carries so the surface can list what was
    /// attempted.
    fn download_via_resolve(
        &self,
        info: &MarketDownloadInfo,
        report: &mut DownloadReport<'_>,
        tried: &mut Vec<TriedMirror>,
    ) -> Result<(PathBuf, String)> {
        let catalog_url = &self.catalog_url;
        let device_id = super::device::device_id(&self.data_dir);
        let resolved =
            super::resolve::request(catalog_url, &device_id, &info.plugin_id, &info.version)?;
        let expected = resolved.sha256.trim().to_ascii_lowercase();
        let attempts = resolved.downloads.len() as u32;
        let mut last_error: Option<anyhow::Error> = None;
        for (index, mirror) in resolved.downloads.iter().enumerate() {
            if report.cancelled() {
                return Err(anyhow!(super::progress::CANCELLED));
            }
            let url = mirror.url.trim();
            if url.is_empty() {
                continue;
            }
            // Resolve mirrors are hosts the platform named, not local catalog
            // fixtures: file:// and bare paths skip the allowlist on the
            // backup path and must not do so here.
            if let Err(error) = super::package_host_allowed(url, catalog_url) {
                tracing::warn!(
                    source = %mirror.source,
                    %url,
                    %error,
                    "this mirror is not an allowed package host"
                );
                tried.push(TriedMirror {
                    source: mirror.source.clone(),
                    url: url.to_string(),
                    error: Some(error.to_string()),
                });
                last_error = Some(error);
                continue;
            }
            report.mirror(Some(&mirror.source), index as u32 + 1, attempts);
            match self.download(info, url, &expected, resolved.size_bytes, report) {
                Ok(path) => return Ok((path, expected)),
                Err(error) => {
                    tracing::warn!(
                        source = %mirror.source,
                        %url,
                        %error,
                        "this mirror did not serve the package"
                    );
                    // A cancellation is not a mirror's fault: stop asking.
                    if super::progress::is_cancelled(&error) {
                        return Err(error);
                    }
                    tried.push(TriedMirror {
                        source: mirror.source.clone(),
                        url: url.to_string(),
                        error: Some(error.to_string()),
                    });
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| {
            anyhow!("PLUGIN_MARKET_NO_SOURCE: the plugin center listed no usable mirror")
        }))
    }

    /// Download one package URL, verify it, and leave it in the cache.
    fn download(
        &self,
        info: &MarketDownloadInfo,
        url: &str,
        expected_shasum: &str,
        expected_size: u64,
        report: &mut DownloadReport<'_>,
    ) -> Result<PathBuf> {
        if report.cancelled() {
            bail!("{}", super::progress::CANCELLED);
        }
        let cache = self.data_dir.join("plugins/cache/download").join(format!(
            "{}-{}.piplug",
            sanitize_id(&info.plugin_id),
            sanitize_id(&info.version)
        ));
        if let Some(parent) = cache.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = if let Some(path) = url.strip_prefix("file://") {
            let bytes = fs::read(path).with_context(|| format!("read market package {path}"))?;
            report.bytes(bytes.len() as u64, expected_size.max(bytes.len() as u64));
            bytes
        } else if url.starts_with("http://") || url.starts_with("https://") {
            // Refuse an off-allowlist host before any request leaves the
            // machine, then hold the redirect chain to the same rule.
            super::package_host_allowed(url, &self.catalog_url)?;
            super::install::download_url_observed(
                url,
                Some(&self.catalog_url),
                expected_size,
                report,
            )?
        } else {
            // Allow bare local paths in catalogs.
            let bytes = fs::read(url).with_context(|| format!("read market package {url}"))?;
            report.bytes(bytes.len() as u64, expected_size.max(bytes.len() as u64));
            bytes
        };
        // A cancellation that arrived while the bytes were being read still
        // stops before anything is verified or written.
        if report.cancelled() {
            bail!("{}", super::progress::CANCELLED);
        }
        report.phase(InstallPhase::Verify);
        if bytes.len() as u64 > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        // A size the platform stated is a sanity check that costs nothing and
        // catches a mirror serving an unrelated file before the digest does.
        if expected_size > 0 && bytes.len() as u64 != expected_size {
            bail!(
                "PLUGIN_INTEGRITY: package is {} bytes, {expected_size} were announced",
                bytes.len()
            );
        }
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(expected_shasum) {
            bail!("PLUGIN_INTEGRITY: checksum mismatch");
        }
        fs::write(&cache, &bytes)?;
        Ok(cache)
    }
}
