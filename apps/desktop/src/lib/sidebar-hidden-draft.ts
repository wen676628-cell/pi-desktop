/**
 * Which unused new-task drafts stay out of the sidebar.
 *
 * A New Task click still creates a durable empty session — that record is what
 * makes the composer's draft, model pin, and project binding survive a
 * navigation, and what the next New Task click reuses instead of stacking a
 * second empty slot. What it must not do is present itself as a conversation:
 * a session nobody has written into is not something the user started, and a
 * row labelled with the default title under the project's tasks reads like the
 * app kept something they never made.
 *
 * So an untouched draft takes no sidebar row — not even while it is open, since
 * the open chat surface already *is* the new-task view. The row appears as soon
 * as the session has content, and every case where the row is the user's own
 * doing stays visible:
 *
 *   - it is running, has live messages, or a submit is in flight;
 *   - it was pinned through the sidebar;
 *   - it is an automation transcript (entered from the Scheduled page);
 *   - it is archived and archived rows are being shown.
 *
 * The record itself is never deleted here: hiding is reversible, deleting a
 * half-typed draft is not.
 */
import type { SessionSummary } from "@pi-desktop/shared";
import { isAutomationSession } from "./session-origin.ts";

export type HiddenDraftContext = {
  /** Pinned through the sidebar, which only happens by explicit user action. */
  pinned: boolean;
  /** A turn is in flight; the transcript may still be empty for a moment. */
  running: boolean;
  /** Composer text was submitted and has not landed as a message yet. */
  submitted?: boolean;
  /** Archived rows are visible in the current sidebar mode. */
  showingArchived?: boolean;
  /** Live (not yet persisted) message count, when the store has one. */
  liveMessageCount?: number;
  /** Archived flag from this session's sidebar metadata. */
  archived?: boolean;
};

/**
 * True when the session is an untouched new-task draft and must not take a
 * sidebar row.
 */
export function sessionIsHiddenDraft(
  session: Pick<SessionSummary, "messageCount" | "worktree" | "scheduledRun">,
  context: HiddenDraftContext,
): boolean {
  // Only a count we actually have may hide a row: a summary without the field
  // (older payload, remote shape) is treated as "has content". Hiding a real
  // conversation is far worse than listing an empty one.
  if (typeof session.messageCount !== "number" || session.messageCount > 0) return false;
  if (context.running || context.submitted === true) return false;
  if ((context.liveMessageCount ?? 0) > 0) return false;
  if (context.pinned) return false;
  if (isAutomationSession(session)) return false;
  // An archived empty session is a deliberate keep, and it is only listed when
  // archiving is being shown; hiding it there would contradict that view.
  if (context.archived === true && context.showingArchived === true) return false;
  return true;
}
