/**
 * Per-session dedup for auto-retrieved memory injection.
 *
 * A memory row is injected into the model context at most once per session:
 * injection results are persisted in `retrieved_memories(session_id,
 * memory_id)` so the rule survives process restarts and session resumes. The
 * rows are cleared after context compaction (the model has effectively
 * forgotten the injected facts). Session end (quit) does not clear the rows:
 */

import { DatabaseManager } from './db.js';

function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Ids of memory rows already injected in the given session. */
export function getRetrievedMemoryIds(
  dbManager: DatabaseManager,
  sessionId: string,
): Set<number> {
  const rows = dbManager.getDb().prepare(`
    SELECT memory_id
    FROM retrieved_memories
    WHERE session_id = ?
  `).all(sessionId) as Array<{ memory_id: number }>;
  return new Set(rows.map((row) => Number(row.memory_id)));
}

/** Record that the given memory rows were injected in this session (idempotent). */
export function markRetrievedMemoryIds(
  dbManager: DatabaseManager,
  sessionId: string,
  memoryIds: Iterable<number>,
): void {
  const db = dbManager.getDb();
  const stamp = today();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO retrieved_memories (session_id, memory_id, retrieved_at)
    VALUES (?, ?, ?)
  `);
  if (typeof db.transaction === "function") {
    const tx = db.transaction(() => {
      for (const id of memoryIds) insert.run(sessionId, id, stamp);
    });
    tx();
    return;
  }
  for (const id of memoryIds) insert.run(sessionId, id, stamp);
}

/** Forget all injections for a session (after context compaction). */
export function resetSessionRetrievals(
  dbManager: DatabaseManager,
  sessionId: string,
): void {
  dbManager.getDb().prepare(`
    DELETE FROM retrieved_memories
    WHERE session_id = ?
  `).run(sessionId);
}

/** Prune stale rows left behind by sessions that crashed without shutdown. */
export function pruneRetrievalRows(
  dbManager: DatabaseManager,
  maxAgeMs: number,
): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString().split('T')[0];
  const result = dbManager.getDb().prepare(`
    DELETE FROM retrieved_memories
    WHERE retrieved_at < ?
  `).run(cutoff);
  return result.changes;
}