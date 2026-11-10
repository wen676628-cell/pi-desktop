# Pi 1.5.1 adoption

## Scope

Upgrade Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, plus
Desktop's `pi-ai` and `pi-mcp`, from exactly 1.5.0 to exactly 1.5.1. The Pi
release group stays aligned through the lockfile and the exact release-age
exclusions. No Host protocol, database schema, persisted provider endpoint,
permission policy, extension `VERSION` marker, or storage ownership changes.

Official release notes: [Pi 1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1).

## Compatibility work

- Rebase the three pnpm patches onto the published 1.5.1 package layouts and
  rename them to `@1.5.1`. `pi-agent-core` applied unchanged. Two packages
  needed manual ports:

  - `pi-ai` / `dist/api/anthropic-messages.js`: 1.5.1 added message threads
    (`prepareThreadRequest`, `sendThreadRequest`, `compat.supportsMessageThreads`)
    and replaced the plain error message with `withCauseDetail`. Resolved by
    keeping the patch's hosted-search and local-request-error handling inside
    the request try-block, computing `compat` there so the thread branch still
    resolves, and serializing the exact body (`prepared?.body ?? params`) before
    the network call so a local payload error is still attributed to
    preparation. `errorMessage` prefers the local-request detail and falls back
    to `withCauseDetail`.
  - `pi-ai` / `dist/api/simple-options.js`: 1.5.1 rewrote the max-token fit
    around a 15% OpenRouter margin. Combined with the patch's model-aware
    estimator (`estimateContextTokens(context, model)`), leaving the new margin
    logic intact.
  - `pi-ai` new files (`hosted-search`, `local-request-error`,
    `local-request-stream`): carried verbatim; 1.5.1 does not ship them.
  - `pi-coding-agent` / `dist/core/compaction/utils.js`: 1.5.1 truncates
    summaries through `sliceHead`. Kept both imports (`sliceHead` and
    `hostedSearchReplayProjection`) and 1.5.1's truncation body.

- Patch verification stays mechanical: `scripts/check-pi-patches.mjs` reads the
  audited markers from the patch text and the installed package hashes;
  `scripts/check-pi-dependencies.mjs` pins the exact version and rejects any
  lockfile entry for `1.0`–`1.4` or `1.5.0`.

## Inherited without Desktop code changes

- Shell credential commands (`pi auth login` / `logout`).
- Idle prompt-cache warming (up to 30 minutes between runs).
- Anthropic message threads and strict tool-limit fallback accounting.
- OpenRouter input-counting margin for `max_tokens`.

## Verification

- The three patches apply cleanly to the published 1.5.1 tarballs
  (`git apply --check`), and every audited marker is present.
- `pnpm check:pi-deps`, `pnpm check:pi-patches`, and the runtime/identity
  suites run in CI against the installed 1.5.1 packages; the 1.5.0 adoption
  record stays as the historical baseline.
