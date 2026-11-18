# ADR: RPC module decomposition strategy

## Status

Accepted — policy decision, not a refactor commitment.

## Context

`crates/host-core/src/rpc/mod.rs` is **11,932 lines** and holds about **192
method dispatch arms** in one match. AGENTS.md §7 lists it as a hotspot that
must "SHRINK OR STAY STABLE" and suggests Rust modules below ~700 lines with a
reconsideration point around ~1,000. The file also carries the request envelope,
error mapping, permission gating, and the handler bodies for a dozen unrelated
domains.

The same pressure shows in neighbours: `sessions.rs` (9,116), `plugins/mod.rs`
(6,159), `transcripts.rs` (2,926). Every upstream sync and every feature PR
touches `rpc/mod.rs`, so it is also the largest conflict surface in the
repository.

A big-bang split is the wrong answer: the file is the host's public surface, it
is covered largely by behavioural tests that assume one dispatch path, and a
mass move would put every in-flight branch in conflict at once.

## Decision

Treat decomposition as a **ratchet**, not a project:

1. **The dispatch table stays, the bodies leave.** `rpc/mod.rs` keeps the match
   as wiring: `"domain.method" => domain::method(state, params, …).await,`.
   Handler bodies, argument parsing, and response shaping live in a module
   named for the domain.
2. **Domain seams** (the natural groups already visible in the dispatch arms):
   `sessions`, `transcripts`, `providers`/`models`, `plugins`, `lsp`, `mcp`,
   `plans`/`mode_runs`, `config`/`settings`, `filesystem`/`workspace`,
   `automation`/`scheduled`, `memory`.
3. **New work goes to the domain module.** Adding an RPC method must not grow
   `rpc/mod.rs` beyond the dispatch arm plus a type re-export. Applies from now.
4. **Touched-domain extraction.** A change that would add more than ~100 net
   lines to `rpc/mod.rs` first extracts the domain it touches into
   `rpc/<domain>.rs` as a behavior-preserving step (same PR, two commits, tests
   unchanged).
5. **Budget with headroom.** A source-contract test fails when `rpc/mod.rs`
   exceeds **12,500 lines**, leaving ~568 lines of headroom today. The threshold
   is lowered only after an extraction lands, never raised.
6. **Order of extraction** (lowest risk first): `lsp` → `mcp` →
   `automation`/`scheduled` → `config` → `providers` → `plugins` → `sessions`.
   Each step is shippable alone, keeps the wire protocol identical, and needs no
   schema or client change.

## Consequences

- New domains stop adding to the hotspot; the file can only shrink or stay flat.
- Extraction PRs are reviewable in isolation: they move code, keep the dispatch
  arm, and are proven by the existing behavioural tests.
- Upstream syncs keep shrinking their conflict surface instead of growing it.
- Cost: seven potential extraction PRs, each mechanical but sizeable; the budget
  test will block an impatient "just add it here" until the arm is extracted,
  which is the point.
- The budget is a tripwire, not a design target: reaching 12,500 lines means the
  ratchet was ignored, not that the file is acceptable.

## Verification

- `apps/desktop/test/rpc-module-budget.test.mjs` reads `rpc/mod.rs` and fails
  above the budget, naming the current count and the extraction order.
- Each extraction cites this ADR and reports the before/after line counts.
