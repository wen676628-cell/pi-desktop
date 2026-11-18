/**
 * Unused new-task drafts stay out of the sidebar (2026-11-18 UI report).
 *
 * A New Task click still writes a durable empty session so drafts, the model
 * pin, and reuse survive navigation; it just must not read as a conversation
 * the user started. These tests pin both halves: untouched drafts hide (even
 * while open), and every case where the row is the user's own doing stays.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sessionIsHiddenDraft } from "../src/lib/sidebar-hidden-draft.ts";

const draft = { messageCount: 0 };
const shown = { pinned: false, running: false };

test("an untouched new-task draft takes no sidebar row", () => {
  assert.equal(sessionIsHiddenDraft(draft, shown), true);
});

test("the open draft is hidden too: the chat surface is the new-task view", () => {
  // This is the reported case — a brand-new conversation with no message must
  // not appear as a task row just because it is selected.
  assert.equal(sessionIsHiddenDraft(draft, shown), true);
});

test("a session with content is never hidden", () => {
  assert.equal(sessionIsHiddenDraft({ messageCount: 1 }, shown), false);
  assert.equal(sessionIsHiddenDraft({ messageCount: 3 }, shown), false);
});

test("a summary without a message count is treated as having content", () => {
  // An older payload or a remote summary may omit the field; hiding a real
  // conversation is worse than listing an empty one.
  assert.equal(sessionIsHiddenDraft({}, shown), false);
  assert.equal(sessionIsHiddenDraft({ messageCount: undefined }, shown), false);
});

test("a submit in flight or a live turn keeps the row visible", () => {
  assert.equal(sessionIsHiddenDraft(draft, { ...shown, submitted: true }), false);
  assert.equal(sessionIsHiddenDraft(draft, { ...shown, liveMessageCount: 1 }), false);
  assert.equal(sessionIsHiddenDraft(draft, { ...shown, running: true }), false);
});

test("pinning is explicit intent and keeps the row", () => {
  assert.equal(sessionIsHiddenDraft(draft, { ...shown, pinned: true }), false);
});

test("automation transcripts are never hidden by this rule", () => {
  assert.equal(
    sessionIsHiddenDraft({ ...draft, scheduledRun: true }, shown),
    false,
    "scheduled runs are entered from the Scheduled page and keep their own row",
  );
});

test("archived drafts stay listed while archived rows are shown", () => {
  assert.equal(
    sessionIsHiddenDraft(draft, { ...shown, archived: true, showingArchived: true }),
    false,
  );
  // Archived but the list is filtered to active work: the archived filter has
  // already removed it, so this rule does not need to keep it.
  assert.equal(
    sessionIsHiddenDraft(draft, { ...shown, archived: true, showingArchived: false }),
    true,
  );
});
