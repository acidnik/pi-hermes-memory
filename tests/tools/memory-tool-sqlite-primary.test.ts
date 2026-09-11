/**
 * Tests for the SQLite-primary write path (Task 0): in default policy-only
 * mode, memory_add / memory_replace / memory_remove persist straight into
 * SQLite — it is the source of truth — while the Markdown files are only an
 * optional human-readable mirror (`markdownMirror: false` disables them).
 * The character cap and auto-consolidation gate live on the legacy Markdown
 * path only.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemories, searchMemories } from "../../src/store/sqlite-memory-store.js";
import { MEMORY_FILE, USER_FILE } from "../../src/constants.js";

function policyOnlyConfig(memoryDir: string, overrides: Record<string, unknown> = {}) {
  return {
    memoryMode: "policy-only" as const,
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

describe("registerMemoryTool — SQLite-primary write path", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tool-sqlite-primary-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureAddTool(): void {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!captured || def.name === "memory_add") captured = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];
    void captured;
    void mockPi;
  }

  it("markdownMirror:false — add/replace/remove never touch Markdown files", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];

    const store = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    await store.loadFromDisk();
    registerMemoryTool(mockPi, store, null, dbManager);

    const added = await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "alpha entry" },
      undefined, undefined, undefined,
    );
    assert.equal(added.details.success, true);

    // No Markdown files are created or updated for any target.
    assert.equal(fs.existsSync(path.join(tmpDir, MEMORY_FILE)), false);
    assert.equal(fs.existsSync(path.join(tmpDir, USER_FILE)), false);

    // The entry is immediately searchable in SQLite.
    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.deepStrictEqual(rows.map((row) => row.content), ["alpha entry"]);
    assert.ok(searchMemories(dbManager, "alpha", { target: "memory" }).some((row) => row.content === "alpha entry"));

    // replace and remove keep SQLite authoritative without the files.
    let capturedReplace: any;
    let capturedRemove: any;
    const mockPi2 = {
      registerTool: (def: any) => {
        if (def.name === "memory_replace") capturedReplace = def;
        if (def.name === "memory_remove") capturedRemove = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];
    registerMemoryTool(mockPi2, store, null, dbManager);
    const replaced = await capturedReplace.execute(
      "tc-2",
      { target: "memory", old_text: "alpha", content: "beta entry" },
      undefined, undefined, undefined,
    );
    assert.equal(replaced.details.success, true);
    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: null }).map((row) => row.content),
      ["beta entry"],
    );

    const removed = await capturedRemove.execute(
      "tc-3",
      { target: "memory", old_text: "beta" },
      undefined, undefined, undefined,
    );
    assert.equal(removed.details.success, true);
    assert.deepStrictEqual(getMemories(dbManager, { target: "memory", project: null }), []);
    assert.equal(fs.existsSync(path.join(tmpDir, MEMORY_FILE)), false);
  });

  it("policy-only with default mirror writes Markdown as a human-readable export", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];

    const store = new MemoryStore(policyOnlyConfig(tmpDir) as any);
    await store.loadFromDisk();
    registerMemoryTool(mockPi, store, null, dbManager);

    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "exported entry" },
      undefined, undefined, undefined,
    );

    assert.ok(fs.existsSync(path.join(tmpDir, MEMORY_FILE)));
    assert.ok(fs.readFileSync(path.join(tmpDir, MEMORY_FILE), "utf-8").includes("exported entry"));
    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.deepStrictEqual(rows.map((row) => row.content), ["exported entry"]);
  });

  it("loadFromDisk reads the authoritative scope from SQLite when the mirror is disabled", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];

    // First session writes into SQLite with the mirror disabled.
    const store1 = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    await store1.loadFromDisk();
    registerMemoryTool(mockPi, store1, null, dbManager);
    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "persistent note" },
      undefined, undefined, undefined,
    );

    // A fresh session in the same directory must see the same entries through
    // SQLite even though no Markdown file was ever written.
    let capturedResult2: any;
    const mockPi2 = {
      registerTool: (def: any) => {
        if (!capturedResult2 || def.name === "memory_add") capturedResult2 = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];
    const store2 = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    registerMemoryTool(mockPi2, store2, null, dbManager);
    await store2.loadFromDisk();

    assert.deepStrictEqual(store2.getMemoryEntries(), ["persistent note"]);
    assert.equal(fs.existsSync(path.join(tmpDir, MEMORY_FILE)), false);
  });

  it("failure writes carry structured metadata into SQLite and round-trip through the loader", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];

    const store = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    await store.loadFromDisk();
    registerMemoryTool(mockPi, store, null, dbManager);

    await capturedResult.execute(
      "tc-1",
      {
        action: "add",
        target: "failure",
        content: "do not parallelize tests against the shared db",
        category: "correction",
        failure_reason: "unique-constraint collisions",
      },
      undefined, undefined, undefined,
    );

    const rows = getMemories(dbManager, { target: "failure" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, "correction");
    assert.equal(rows[0].failureReason, "unique-constraint collisions");
    assert.ok(rows[0].content.includes("do not parallelize tests"));

    // A reloaded store sees the failure through the SQLite scope loader.
    let capturedResult2: any;
    const mockPi2 = {
      registerTool: (def: any) => {
        if (!capturedResult2 || def.name === "memory_add") capturedResult2 = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];
    const store2 = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    registerMemoryTool(mockPi2, store2, null, dbManager);
    await store2.loadFromDisk();
    assert.ok(store2.getAllFailureEntries().some((entry) => entry.includes("do not parallelize tests")));

    // And it is searchable.
    assert.ok(searchMemories(dbManager, "parallelize", { target: "failure" }).length > 0);
  });

  it("project stores stay scoped: global loader never sees project rows", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as Parameters<typeof registerMemoryTool>[0];

    const store = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    const projectStore = new MemoryStore(policyOnlyConfig(path.join(tmpDir, "proj"), { markdownMirror: false }) as any);
    registerMemoryTool(mockPi, store, projectStore, dbManager, "project-a");
    await store.loadFromDisk();
    await projectStore.loadFromDisk();

    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "project", content: "project scope note" },
      undefined, undefined, undefined,
    );
    await capturedResult.execute(
      "tc-2",
      { action: "add", target: "memory", content: "global scope note" },
      undefined, undefined, undefined,
    );

    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: "project-a" }).map((row) => row.content),
      ["project scope note"],
    );
    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: null }).map((row) => row.content),
      ["global scope note"],
    );
    assert.deepStrictEqual(store.getMemoryEntries(), ["global scope note"]);
    assert.deepStrictEqual(projectStore.getMemoryEntries(), ["project scope note"]);
  });
});

describe("MemoryStore — SQLite-primary adapter contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-adapter-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persist writes the full scope to the primary writer first and honors the mirror flag", async () => {
    const store = new MemoryStore(policyOnlyConfig(tmpDir, {
      markdownMirror: false,
      memoryCharLimit: 1, // cap is irrelevant on the SQLite-primary path
    }) as any);
    const written: Record<string, string[]> = {};
    store.setSqlitePrimaryWriter(async (target, entries) => {
      written[target] = entries;
      return null;
    });
    store.setSqliteScopeLoader(async (target) => written[target] ?? []);
    await store.loadFromDisk();

    const result = await store.add("memory", "way over the tiny cap");
    assert.equal(result.success, true, result.error);
    assert.ok(
      written.memory?.some((entry) => entry.includes("way over the tiny cap")),
      "primary writer received the authoritative entry list",
    );
    // Markdown mirror disabled → no file.
    assert.equal(fs.existsSync(path.join(tmpDir, MEMORY_FILE)), false);
    // loadFromDisk + finalize reload come from the SQLite scope loader.
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("way over the tiny cap")));
  });

  it("loadFromDisk prefers the SQLite scope loader over Markdown files", async () => {
    const store = new MemoryStore(policyOnlyConfig(tmpDir, { markdownMirror: false }) as any);
    const state: Record<string, string[]> = {
      memory: ["imported from sqlite <!-- created=2026-01-01, last=2026-01-01 -->"],
    };
    store.setSqliteScopeLoader(async (target) => state[target] ?? []);
    await store.loadFromDisk();
    assert.deepStrictEqual(store.getMemoryEntries(), ["imported from sqlite"]);
  });
});
