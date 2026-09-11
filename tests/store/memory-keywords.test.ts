/**
 * Tests for keyword synonyms / equivalents in memory extraction and search
 * (Task: keywords).
 *
 * Keywords make entry searchable by alternate word forms: they are stored in
 * the SQLite `memories.keywords` column (JSON array), mirrored into the
 * Markdown entry metadata (`keys=...`), and indexed by the second FTS5 column
 * so a plain MATCH spans both content and keywords.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DatabaseManager } from "../../src/store/db.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import {
  addMemory,
  getMemories,
  searchMemories,
  syncMemoryEntry,
  parseMarkdownMemoryEntry,
  formatMarkdownMemoryEntry,
  formatFailureMemoryContent,
} from "../../src/store/sqlite-memory-store.js";

describe("keywords — SQLite storage and search", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-keywords-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("searchMemories matches the keywords column (synonyms / other languages / inflections)", () => {
    syncMemoryEntry(dbManager, {
      content: "prefers pnpm over npm",
      target: "memory",
      keywords: ["index", "indices", "индекс"],
    });

    // Direct content hit still works.
    assert.ok(searchMemories(dbManager, "pnpm", { target: "memory" }).length > 0);
    // Hits through the keywords column: English plural and Russian form.
    assert.ok(searchMemories(dbManager, "indices", { target: "memory" }).length > 0);
    assert.ok(searchMemories(dbManager, "индекс", { target: "memory" }).length > 0);
    // A form that was never stored stays unmatched.
    assert.strictEqual(searchMemories(dbManager, "индексация", { target: "memory" }).length, 0);
  });

  it("failure entries carry keywords through formatFailureMemoryContent + sync", () => {
    const row = syncMemoryEntry(dbManager, {
      content: formatFailureMemoryContent("do not parallelize tests", { category: "correction" }),
      target: "failure",
      category: "correction",
      keywords: ["tests", "parallel", "параллельно"],
    }).entry;
    assert.deepStrictEqual(row.keywords, ["tests", "parallel", "параллельно"]);
    assert.ok(searchMemories(dbManager, "параллельно", { target: "failure" }).length > 0);
    assert.ok(searchMemories(dbManager, "parallel", { target: "failure" }).length > 0);
  });

  it("legacy rows without keywords stay searchable and serialize without keys=", () => {
    const entry = addMemory(dbManager, "plain durable fact", "memory");
    assert.strictEqual(entry.keywords, null);

    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].keywords, null);
    assert.ok(searchMemories(dbManager, "durable", { target: "memory" }).length > 0);

    // Markdown serialization omits keys= for keyword-less entries, and parsing
    // the serialized form round-trips to keywords: null.
    const serialized = formatMarkdownMemoryEntry(rows[0]);
    assert.ok(!serialized.includes("keys="));
    const parsed = parseMarkdownMemoryEntry(serialized, "memory");
    assert.strictEqual(parsed.keywords, null);
    assert.strictEqual(parsed.content, "plain durable fact");
  });

  it("Markdown key metadata round-trips back into the sync input", () => {
    const serialized = formatMarkdownMemoryEntry({
      id: 1,
      project: null,
      target: "memory",
      category: null,
      content: "vim over vscode",
      keywords: ["vim", "neovim", "nvim", "редактор"],
      failureReason: null,
      toolState: null,
      correctedTo: null,
      created: "2026-09-01",
      lastReferenced: "2026-09-01",
    });
    assert.ok(serialized.includes("keys=vim, neovim, nvim, редактор"));

    const parsed = parseMarkdownMemoryEntry(serialized, "memory");
    assert.deepStrictEqual(parsed.keywords, ["vim", "neovim", "nvim", "редактор"]);
    assert.strictEqual(parsed.content, "vim over vscode");
  });

  it("LIKE fallbacks search content and keywords alike (short CJK and stop-word queries)", () => {
    syncMemoryEntry(dbManager, {
      content: "has a theory about bases",
      target: "memory",
      keywords: ["基数", "ベース"],
    });

    // Two-char CJK term: trigram cannot index it, falls back to LIKE which now
    // also scans the keywords column.
    assert.ok(searchMemories(dbManager, "基数", { target: "memory" }).length > 0);
    // Stop-word-only query degrades to a literal LIKE search across both columns.
    assert.ok(searchMemories(dbManager, "the", { target: "memory" }).length > 0);
  });

  it("upgrades a legacy database: adds the keywords column and the two-column FTS index", () => {
    // Build a pre-keywords database exactly like earlier releases left it:
    // single-column memory_fts (trigram), old triggers, no keywords anywhere.
    const legacyPath = path.join(tmpDir, "sessions.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE extension_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT,
        target TEXT NOT NULL,
        category TEXT,
        content TEXT NOT NULL,
        failure_reason TEXT,
        tool_state TEXT,
        corrected_to TEXT,
        created DATE NOT NULL,
        last_referenced DATE NOT NULL
      );
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        content,
        content='memories',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
      END;
      INSERT INTO memories (target, content, created, last_referenced)
      VALUES ('memory', 'legacy fact about indices', '2026-05-01', '2026-05-01');
    `);
    legacy.close();

    dbManager.close();
    dbManager = new DatabaseManager(tmpDir);
    const db = dbManager.getDb();

    // memories gained the keywords column; the FTS index gained it too.
    const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    assert.ok(memoryColumns.some((column) => column.name === "keywords"), "memories.keywords missing after migration");
    const ftsColumns = db.prepare("PRAGMA table_info(memory_fts)").all() as Array<{ name: string }>;
    assert.ok(ftsColumns.some((column) => column.name === "keywords"), "memory_fts.keywords missing after migration");

    // Pre-existing data survived the FTS rebuild.
    const migrated = getMemories(dbManager, { target: "memory", project: null });
    assert.strictEqual(migrated.length, 1);
    assert.strictEqual(migrated[0].keywords, null);
    assert.ok(searchMemories(dbManager, "indices", { target: "memory" }).length > 0);

    // New rows with keywords are indexed and searchable.
    syncMemoryEntry(dbManager, {
      content: "legacy-friendly",
      target: "memory",
      keywords: ["legacy", "старый"],
    });
    assert.ok(searchMemories(dbManager, "старый", { target: "memory" }).length > 0);

    // The migration is idempotent — reopening leaves the markers in place.
    dbManager.close();
    dbManager = new DatabaseManager(tmpDir);
    const reopened = dbManager.getDb();
    assert.ok(reopened.prepare("PRAGMA table_info(memory_fts)").all().some(
      (column) => (column as { name: string }).name === "keywords",
    ));
  });
});

describe("keywords — MemoryStore and memory tool integration", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-keywords-store-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function policyOnlyConfig(memoryDir: string, overrides: Record<string, unknown> = {}) {
    return {
      memoryMode: "policy-only" as const,
      markdownMirror: false,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      projectCharLimit: 5000,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      failureInjectionEnabled: true,
      failureInjectionMaxAgeDays: 7,
      failureInjectionMaxEntries: 5,
      nudgeToolCalls: 15,
      consolidationTimeoutMs: 60000,
      memoryDir,
      ...overrides,
    };
  }

  it("memory_add with keywords lands in SQLite and survives a scope reload", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as Parameters<typeof import("../../src/tools/memory-tool.js").registerMemoryTool>[0];

    const store = new MemoryStore(policyOnlyConfig(tmpDir) as any);
    await store.loadFromDisk();
    const { registerMemoryTool } = await import("../../src/tools/memory-tool.js");
    registerMemoryTool(mockPi, store, null, dbManager);

    const result = await capturedResult.execute(
      "tc-1",
      {
        action: "add",
        target: "memory",
        content: "rust async runtimes",
        keywords: ["tokio", "async-std", "async", "асинхронность"],
      },
      undefined, undefined, undefined,
    );
    assert.equal(result.details.success, true);

    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].keywords, ["tokio", "async-std", "async", "асинхронность"]);
    assert.ok(searchMemories(dbManager, "асинхронность", { target: "memory" }).length > 0);

    // A fresh store in the same directory reloads keywords through the SQLite scope loader.
    let capturedResult2: any;
    const mockPi2 = {
      registerTool: (def: any) => {
        if (!capturedResult2 || def.name === "memory_add") capturedResult2 = def;
      },
    } as unknown as Parameters<typeof import("../../src/tools/memory-tool.js").registerMemoryTool>[0];
    const store2 = new MemoryStore(policyOnlyConfig(tmpDir) as any);
    registerMemoryTool(mockPi2, store2, null, dbManager);
    await store2.loadFromDisk();
    assert.strictEqual(store2.getMemoryEntries().length, 1);
  });

  it("store-level round-trip: keys live in the encoded entry and come back through the primary writer", async () => {
    const store = new MemoryStore(policyOnlyConfig(tmpDir) as any);
    const written: Record<string, string[]> = {};
    store.setSqlitePrimaryWriter(async (target, entries) => {
      written[target] = entries;
      return null;
    });
    store.setSqliteScopeLoader(async (target) => written[target] ?? []);
    await store.loadFromDisk();

    const result = await store.add("memory", "index and search", undefined, { keywords: ["index", "indices", "индекс"] });
    assert.equal(result.success, true, result.error);
    assert.ok(
      written.memory?.some((entry) => entry.includes("keys=index, indices, индекс")),
      "encoded entry should carry the keys metadata",
    );
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("index and search")));
  });
});
