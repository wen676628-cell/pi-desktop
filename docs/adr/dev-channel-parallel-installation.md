# ADR: Dev-channel parallel installation

## Status

Proposed

## Context

The fork publishes one Windows installer per release. Users who want to test
pre-release builds must either uninstall their stable installation or risk
their real application data (sessions, provider secrets, project records).

PiDeck demonstrates the model works at scale: a parallel **Dev** installer
with its own appId, install directory, deep-link protocol, and a data-mode
choice on first launch ("share data with stable" or "independent data
directory", switchable later with a guided migration). Stable and Dev can be
installed side by side without interference.

The fork already has the pieces that make this cheap:

- `storage-location.json` under Electron `userData` already redirects the data
  root, so a second data directory is a preference change, not a code path.
- `apps/desktop/package.json` owns `build.appId`, `build.productName`, and the
  artifact names; `electron-builder` derives NSIS install identity from them.
- The updater already reads a caller-selected release feed
  (`apps/desktop/electron/main/updater.ts`, `RELEASES_URL`), so a Dev channel
  can point at pre-releases (`-beta.*` tags) while stable ignores them
  (electron-updater's `allowPrerelease`).

## Decision

Introduce a **build-time channel** (`stable` | `dev`), selected by the build
command — never by the version string:

1. **Packaging**: `dist:win:dev` (and mac/linux dev variants) pass
   `-c.extraMetadata.piChannel=dev` plus a dev suffix to `appId`
   (`net.aiuo.pi-desktop.dev`), `productName` (`PI-Desktop Dev`), and artifact
   names (`PI-Desktop-Dev-*`), matching `build-desktop-release.mjs`'s existing
   extraMetadata injection pattern. Stable scripts inject nothing; a version
   containing `-beta` does not change channel detection.
2. **Identity at runtime**: `app.getName()` and the userData anchor follow the
   channel, so `PI-Desktop Dev` gets its own `userData`, its own
   `storage-location.json`, its own updater state, and its own single-instance
   lock — no shared state with stable.
3. **Deep links**: the Dev build registers `pideck-dev://`-equivalent protocol
   (`pi-desktop-dev://`) so stable's `pi-desktop://` is never stolen.
4. **Updater**: the Dev channel enables `allowPrerelease` and reads the same
   GitHub releases feed; prerelease tags (`-beta.*`) are only offered to Dev.
   Stable keeps `allowPrerelease` off.
5. **First-launch data choice**: when a Dev build starts and detects a stable
   installation's data root, show a one-time choice — share that root
   (read/write) or start independent. The choice persists in the Dev
   `storage-location.json` and is switchable later with the existing
   storage-relocation flow.
6. **Release flow**: prerelease tags (`vX.Y.Z-beta.N`) keep `prerelease:
   true` on the GitHub Release (the workflow already derives this from the
   tag name), so stable updaters never see them.

## Consequences

- Stable and Dev coexist: separate shortcuts, trays, updater feeds, and data.
- Testing a beta no longer touches real provider secrets or sessions — unless
  the user explicitly shares data, which keeps the migration path for people
  who want it.
- The channel marker must be present in diagnostics (About panel, logs) so a
  bug report states which build produced it.
- Cost: two installer lanes per release when a beta is cut; stable-only
  releases are unchanged. `check-release-docs.mjs` skips prereleases already.
- The shared-data mode means Dev writes run against the user's real profile;
  the first-launch choice must state that clearly before the user picks it.

## Rollout

1. Channel plumbing in packaging scripts + runtime identity (no UI).
2. First-launch data choice + diagnostics marker.
3. Dev-channel updater feed wiring (`allowPrerElease` gated by channel).
4. Bilingual README "Dev builds" section.
