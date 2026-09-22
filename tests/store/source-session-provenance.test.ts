/**
 * Provenance filter tests: entries extracted/written by a session carry that
 * session's id (source_session column, `src=` metadata key) and retrieval
 * must never inject them back into the same session. Regression for the
 * feedback loop where background-review extracted facts from a live session
 * and auto-retrieval re-injected them minutes later (the old id-based dedup
 * broke whenever auto-consolidation replaced the row: a fresh unmarked row
 * became injectable again).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import {
  addMemory,
  searchMemories,
  syncMemoryEntry,
  parseMarkdownMemoryEntry,
  formatMarkdownMemoryEntry,
  getMemories,
} from '../../src/store/sqlite-memory-store.js';
import { MemoryStore } from '../../src/store/memory-store.js';
import type { MemoryConfig } from '../../src/types.js';

describe('source-session provenance', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-provenance-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('sqlite column', () => {
    it('addMemory stores sourceSession', () => {
      const entry = addMemory(dbManager, 'hits=287 real rows', 'memory', null, null, null, null, null, undefined, undefined, null, 'sess-A');
      assert.strictEqual(entry.sourceSession, 'sess-A');
    });

    it('addMemory defaults to null sourceSession (legacy rows)', () => {
      const entry = addMemory(dbManager, 'legacy fact');
      assert.strictEqual(entry.sourceSession, null);
    });

    it('searchMemories returns sourceSession', () => {
      addMemory(dbManager, 'cargo check does not update the binary', 'failure', null, 'tool-quirk', null, null, null, undefined, undefined, null, 'sess-A');
      const rows = searchMemories(dbManager, 'cargo check', { target: 'failure' });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].sourceSession, 'sess-A');
    });

    it('syncMemoryEntry write-once provenance: re-sync never overrides the first session', () => {
      syncMemoryEntry(dbManager, { content: 'npz-bingo uses WAN-bound pool', target: 'memory', sourceSession: 'sess-A' });
      const [row] = searchMemories(dbManager, 'WAN-bound', { target: 'memory' });
      assert.strictEqual(row.sourceSession, 'sess-A');

      syncMemoryEntry(dbManager, { content: 'npz-bingo uses WAN-bound pool', target: 'memory', sourceSession: 'sess-B' });
      const [after] = searchMemories(dbManager, 'WAN-bound', { target: 'memory' });
      assert.strictEqual(after.id, row.id);
      assert.strictEqual(after.sourceSession, 'sess-A');
    });

    it('syncMemoryEntry fills missing provenance when the row had none', () => {
      syncMemoryEntry(dbManager, { content: 'no provenance yet', target: 'memory' });
      syncMemoryEntry(dbManager, { content: 'no provenance yet', target: 'memory', sourceSession: 'sess-C' });
      const [row] = searchMemories(dbManager, 'provenance', { target: 'memory' });
      assert.strictEqual(row.sourceSession, 'sess-C');
    });
  });

  describe('markdown metadata round-trip', () => {
    it('src= survives formatMarkdownMemoryEntry -> parseMarkdownMemoryEntry', () => {
      const entry = addMemory(dbManager, 'fact with provenance', 'memory', null, null, null, null, null, undefined, undefined, null, 'sess-XYZ');
      const raw = formatMarkdownMemoryEntry(entry);
      assert.ok(raw.includes('src=sess-XYZ'), `raw entry should carry src=: ${raw}`);
      const parsed = parseMarkdownMemoryEntry(raw, 'memory');
      assert.strictEqual(parsed.sourceSession, 'sess-XYZ');
    });

    it('entries without src parse to null sourceSession', () => {
      const parsed = parseMarkdownMemoryEntry('old entry <!-- created=2026-01-01, last=2026-01-01 -->', 'memory');
      assert.strictEqual(parsed.sourceSession, null);
      const bare = parseMarkdownMemoryEntry('even older entry', 'memory');
      assert.strictEqual(bare.sourceSession, null);
    });

    it('failure entries carry src through the failure-text format', () => {
      const raw = 'npz-bingo: cargo build needed <!-- created=2026-09-22, last=2026-09-22, keys=cargo, project64=bnp6LWJpbmdv, src=sess-A -->';
      const parsed = parseMarkdownMemoryEntry(raw, 'failure', 'npz-bingo');
      assert.strictEqual(parsed.sourceSession, 'sess-A');
      assert.strictEqual(parsed.content, 'npz-bingo: cargo build needed');
      assert.strictEqual(parsed.project, 'npz-bingo');
    });
  });

  describe('MemoryStore fresh-write stamping', () => {
    let store: MemoryStore;
    let config: MemoryConfig;

    beforeEach(() => {
      config = {
        memoryDir: tmpDir,
        projectsMemoryDir: path.join(tmpDir, 'projects'),
        agentRoot: tmpDir,
      } as MemoryConfig;
      store = new MemoryStore(config);
      store.setSessionIdProvider(() => 'sess-live');
    });

    it('add() stamps the current session id into the encoded entry', async () => {
      const result = await store.add('memory', 'a fresh fact', undefined, {});
      assert.ok(result.success);
      const raw = store.getRawEntriesForSync('memory').find((e) => e.includes('a fresh fact'));
      assert.ok(raw, 'entry should exist in the raw scope');
      assert.ok(raw.includes('src=sess-live'), `fresh write should carry src=: ${raw}`);
    });

    it('without a session provider entries stay unstamped', async () => {
      store.setSessionIdProvider(null);
      const result = await store.add('memory', 'unattributed fact', undefined, {});
      assert.ok(result.success);
      const raw = store.getRawEntriesForSync('memory').find((e) => e.includes('unattributed fact'));
      assert.ok(raw && !raw.includes('src='));
    });
  });

  describe('legacy migration', () => {
    it('opening a legacy DB (no source_session column) adds the column without losing rows', () => {
      // Simulate a pre-provenance database by dropping the column via table rebuild.
      const db = (dbManager as unknown as { getDb(): import('node:sqlite').DatabaseSync }).getDb();
      db.exec(`
        CREATE TABLE memories_legacy (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, target TEXT NOT NULL, category TEXT, content TEXT NOT NULL, keywords TEXT, failure_reason TEXT, tool_state TEXT, corrected_to TEXT, created DATE NOT NULL, last_referenced DATE NOT NULL);
        INSERT INTO memories_legacy (project, target, content, created, last_referenced) VALUES (NULL, 'memory', 'old row', '2026-01-01', '2026-01-01');
        DROP TABLE memories;
        ALTER TABLE memories_legacy RENAME TO memories;
      `);
      // Reopen: migrations must patch the schema (ensureMemoriesColumns) and
      // keep the row. FTS is not rebuilt by the ALTER, so verify via the
      // non-FTS read path.
      dbManager.close();
      dbManager = new DatabaseManager(tmpDir);
      const rows = getMemories(dbManager, { target: 'memory' });
      const row = rows.find((entry) => entry.content === 'old row');
      assert.ok(row, 'legacy row must survive the migration');
      assert.strictEqual(row.sourceSession, null);
    });
  });
});
