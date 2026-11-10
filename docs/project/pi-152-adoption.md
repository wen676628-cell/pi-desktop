# Pi 1.5.2 adoption

## Scope

Upgrade Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, plus
Desktop's `pi-ai` and `pi-mcp`, from exactly 1.5.1 to exactly 1.5.2. The Pi
release group stays aligned through the lockfile and the exact release-age
exclusions. No Host protocol, database schema, persisted provider endpoint,
permission policy, extension `VERSION` marker, or storage ownership changes.

Official release notes: [Pi 1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2).

## Compatibility work

- All three pnpm patches apply unchanged to the published 1.5.2 layouts; the
  patch files are renamed to `@1.5.2` and their audited markers are unchanged.
  `git apply --check` passes for `pi-agent-core`, `pi-ai`, and
  `pi-coding-agent`.
- Lockfile regenerated with `pnpm install --lockfile-only`; the dependency
  check rejects any `1.0`–`1.5.1` entry for the pinned packages.
- Identity expectations follow the SDK's reported version: the native-session
  fixture, the User-Agent guard, and the Anthropic token-request guard now
  expect `1.5.2`.

## Inherited without Desktop code changes

- Fork a session whose working directory disappeared into the current folder
  (`Continue` / `Fork` / `Cancel`), and the duplicate-copy fix for `/import`
  of such a session.

## Verification

- The three patches apply to the 1.5.2 tarballs and keep every audited marker.
- `pnpm check:pi-deps`, `pnpm check:pi-patches`, the patch-hash test, and the
  runtime/identity suites run in CI against the installed 1.5.2 packages.
