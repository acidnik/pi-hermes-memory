/**
 * Per-session auto-review delta pointer.
 *
 * Background review tracks the last session entry id it has already handed to
 * the learning loop, so the next run only reviews the branch portion after it
 * (delta) instead of the whole session. The pointer is persisted in
 * `review_progress(session_id, last_entry_id)` so it survives process
 * restarts and session resumes: the full branch is reviewed once per session
 * lifetime (first run without a pointer), and every later run — including the
 * first one after a resume — continues from the persisted entry.
 *
 * Rows are NOT cleared on session_compact or quit (see schema.ts): compaction
 * touches prompt context, not the review pointer, and a resumed session must
 * not re-review what the previous process already saw. reviewDeltaOnly:false
 * never reads or writes these rows.
 */

import { DatabaseManager } from './db.js';

/** Last session entry id already handed to an auto-review, if any. */
export function getReviewProgress(
  dbManager: DatabaseManager,
  sessionId: string,
): string | undefined {
  const row = dbManager.getDb().prepare(`
    SELECT last_entry_id
    FROM review_progress
    WHERE session_id = ?
  `).get(sessionId) as { last_entry_id?: unknown } | undefined;
  const lastEntryId = row?.last_entry_id;
  return typeof lastEntryId === 'string' && lastEntryId.length > 0 ? lastEntryId : undefined;
}

/** Persist the auto-review delta pointer for a session (idempotent upsert). */
export function setReviewProgress(
  dbManager: DatabaseManager,
  sessionId: string,
  lastEntryId: string,
): void {
  dbManager.getDb().prepare(`
    INSERT INTO review_progress (session_id, last_entry_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_entry_id = excluded.last_entry_id,
      updated_at = excluded.updated_at
  `).run(sessionId, lastEntryId, new Date().toISOString());
}