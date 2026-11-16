# Fork upstream sync strategy

How this fork absorbs changes from [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop),
what to sync, what to expect to conflict, and how to keep the fork's own fixes
alive through a sync. Written for the fork maintainer; nothing here changes
upstream behavior.

## 1. Cadence

- **Sync when**: upstream merges a batch of fixes that overlap this fork's
  user-facing surfaces (composer, plugins, sessions, persistence), or before a
  fork release — whichever comes first.
- **Do not sync** in the middle of an unfinished fork feature branch; finish
  and merge it first so sync conflicts are resolved against merged, tested code.
- A full sync is a dedicated task: one branch, one PR, no feature work mixed in.

## 2. What the fork carries that upstream does not

Every item below is a known conflict surface. Before syncing, run a diff of
these files against the upstream versions to predict overlap:

| Fork-specific surface | Location | Conflict risk |
| --- | --- | --- |
| LSP diagnostics host | `crates/host-core/src/lsp/` | Low — upstream has no `lsp/` module; conflicts only where `rpc/mod.rs` dispatches into it |
| Fork release workflow | `.github/workflows/release.yml` | High if upstream changes its own release.yml — keep the fork's `bash <script>` invocation style and the unsigned-fork lane |
| Trusted-renderer IPC gate | `apps/desktop/electron/main/ipc/trusted-renderers.ts`, `ipc/register.ts` | Medium — any upstream change to `registerIpcHandlers` must re-apply `assertTrustedSender` |
| OS-wrapped secret key | `apps/desktop/electron/main/secret-key*.ts`, `crates/host-core/src/secrets.rs` | Medium — upstream may evolve `secrets.rs` independently |
| Local-plugin install review | `crates/host-core/src/plugins/install*.rs`, `apps/desktop/electron/main/ipc/plugin-ipc.ts` | High — `install.rs` was heavily restructured (review staging, atomic registry commit) |
| Outbox dead-letter ordering | `apps/desktop/electron/main/persistence-outbox.ts` | Medium |
| Remote-media gate | `apps/desktop/src/components/Markdown.tsx`, `src/lib/remote-media-policy.ts` | Medium — Markdown.tsx is a hotspot |
| Permission level naming | `packages/i18n/src/locales/*/index.ts`, locale catalogs, `changelog-*.ts` | Low mechanically, high volume — all nine locales |

Fork-only docs that must not be clobbered: `README.md` fork notice + fork
differences section, `README.zh-CN.md`, `CHANGELOG.md` (generated),
`docs/fork-sync-strategy.md` (this file), `UNOFFICIAL-FORK.txt` release asset.

## 3. Sync procedure

1. **Snapshot**: note current `main` SHA and the upstream SHA to absorb
   (`gh api repos/vastsa/PI-Desktop/commits/main --jq .sha`).
2. **Branch**: `git worktree add -b sync/upstream-<short-sha> origin/main`.
3. **Fetch upstream**: `git remote add upstream https://github.com/vastsa/PI-Desktop.git`
   (once), then `git fetch upstream main`. Network resets are common on this
   machine — retry before diagnosing anything else.
4. **Merge or 3-way**: prefer `git merge upstream/main`; where history is
   unreachable, reconstruct upstream commits via the GitHub API (blobs → trees →
   commits) and resolve with `git merge-file` per conflicting file.
5. **Resolve with the fork's tests as the arbiter**: when a conflict touches a
   fork fix, keep the fork behavior if its regression test still passes after
   the merge; keep upstream behavior when the fork has no test covering it.
6. **Re-run the fork regression set** (the tests listed in each PR from #32 on:
   plugin install review, outbox atomicity, trusted renderers, marketplace
   lock, remote media, OS secret backend, permission naming).
7. **PR and full CI** before merging to `main`; never sync directly on `main`.

## 4. What to take from upstream vs. keep local

- **Take**: bug fixes to shared engine code (pi agent engine pins, compaction,
  tool execution), new plugin/panel surfaces, provider and model handling,
  session collaboration — anything the fork does not already own a fixed
  implementation of.
- **Keep**: everything in section 2, unless upstream ships a strictly better
  implementation of the same problem — in that case port the fork's regression
  tests onto the upstream implementation and retire the fork code.
- **Never take**: upstream's release signing requirements into the fork's
  unsigned lane; upstream README badges/links (the fork carries its own
  identity); upstream changelog entries (the fork's `changelog-*.ts` is the
  shipped source of truth and `CHANGELOG.md` is generated from it).

## 5. Release flow after a sync

1. `node scripts/generate-changelog.mjs` regenerates `CHANGELOG.md` from the
   shipped catalog (the catalog gains the new release entry first).
2. `node scripts/release.mjs <version> --tag` bumps surfaces and refuses to tag
   while `check-release-docs.mjs` finds any disagreement.
3. `git push origin <branch> v<version>` triggers release.yml; the macOS lane
   runs unsigned on this fork and the publish job creates the Release.
4. Post-release check: assets include Windows Setup/Portable, Linux packages,
   unsigned macOS dmg/zip, `latest*.yml` feeds, and pi-host bundles.
   `UNOFFICIAL-FORK.txt` is **not** auto-generated — upload it manually or add
   a publish step that writes it (tracked follow-up).

## 6. Known costs

- `crates/host-core/src/rpc/mod.rs` (~12k LOC) and `sessions.rs` (~9k LOC) are
  the largest conflict surfaces; upstream churn there is expensive. Where a
  fork fix touches them, keep the diff inside its own module (the fork already
  moved marketplace download and install review into `plugins/market_download.rs`
  / `plugins/install_review.rs` for this reason).
- Nine-locale string changes (permission naming, changelog) multiply every UI
  rename; batch them per release, not per fix.
