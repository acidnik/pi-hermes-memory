/**
 * SQLite schema for pi-hermes-memory v0.4
 *
 * Tables:
 * - sessions — Pi session metadata
 * - session_files — indexed JSONL metadata for incremental backfill
 * - messages — all conversation messages
 * - message_fts — FTS5 index for full-text search across messages
 * - memories — extended memory entries (unlimited, searchable)
 * - memory_fts — FTS5 index for memory search
 * - retrieved_memories — per-session dedup for auto-retrieved injection
 * - review_progress — per-session auto-review delta pointer
 */

export const SCHEMA_SQL = `
  -- Extension key/value metadata
  CREATE TABLE IF NOT EXISTS extension_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Session metadata
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    message_count INTEGER DEFAULT 0
  );

  -- Indexed session file metadata for cheap incremental backfill
  CREATE TABLE IF NOT EXISTS session_files (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  -- All messages from all sessions
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    tool_calls TEXT
  );

  -- FTS5 trigram indexes support substring search for CJK and retain
  -- normal token search for English. Queries shorter than three characters
  -- are not indexed by the trigram tokenizer.
  CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
  );

  -- Triggers to keep message_fts in sync with messages table
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- Extended memory entries (beyond MEMORY.md limit)
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
    category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
    content TEXT NOT NULL,
    keywords TEXT,
    failure_reason TEXT,
    tool_state TEXT,
    corrected_to TEXT,
    source_session TEXT,
    created DATE NOT NULL,
    last_referenced DATE NOT NULL
  );

  -- FTS5 trigram index for memory substring search. Keywords (synonyms /
  -- equivalents in other languages / inflections) live in a second column so
  -- a plain MATCH spans both content and keywords.
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    keywords,
    content='memories',
    content_rowid='id',
    tokenize='trigram'
  );

  -- Per-session dedup for auto-retrieved memory injection: a memory row is
  -- injected into the model context at most once per session (persisted so
  -- the rule survives process restarts and resumes). Rows are cleared after
  -- context compaction and when the session quits.
  CREATE TABLE IF NOT EXISTS retrieved_memories (
    session_id TEXT NOT NULL,
    memory_id INTEGER NOT NULL,
    retrieved_at TEXT NOT NULL,
    PRIMARY KEY (session_id, memory_id)
  );

  -- Per-session auto-review delta pointer: the last session entry id already
  -- handed to a background review, persisted so the full branch is delta-
  -- reviewed once per session lifetime and a resumed process continues from
  -- where the previous one stopped. Rows are kept on session_compact and
  -- quit (like retrieved_memories): compaction touches prompt context, not
  -- the review pointer, and a quit+resume must not re-review the whole branch.
  CREATE TABLE IF NOT EXISTS review_progress (
    session_id TEXT PRIMARY KEY,
    last_entry_id TEXT,
    updated_at TEXT NOT NULL
  );

  -- Triggers to keep memory_fts in sync with memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
    INSERT INTO memory_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
  END;

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_session_files_session_id ON session_files(session_id);
`;
