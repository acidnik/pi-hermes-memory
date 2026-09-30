/**
 * Unit tests for memory tool registration and execute function.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemories, searchMemories, syncMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";
import { Value } from "typebox/value";

describe("registerMemoryTool", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tool-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers action-specific memory tools with required parameters", () => {
    const registeredTools: any[] = [];

    const mockPi = {
      registerTool: (def: any) => {
        registeredTools.push(def);
      },
    } as unknown as ExtensionAPI;

    registerMemoryTool(mockPi, {} as MemoryStore, null);

    assert.deepStrictEqual(
      registeredTools.map((tool) => tool.name),
      ["memory_add", "memory_replace", "memory_remove"],
    );
    for (const tool of registeredTools) {
      assert.ok(tool.description.length > 0);
      assert.ok(tool.promptSnippet.length > 0);
      assert.ok(Array.isArray(tool.promptGuidelines));
      assert.ok(tool.parameters);
    }
  });

  it("execute add returns JSON with entry count", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    assert.strictEqual(result.content[0].type, "text", "content should be text type");
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true, "result should be success");
    assert.strictEqual(parsed.entry_count, 1, "entry_count should be 1");
    assert.strictEqual(result.details.success, true, "details should mirror result");
  });

  it("keeps display-only fields out of the model-facing payload", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "user",
        entry_count: 3,
        message: "Entry added.",
        // Display-only context from MemoryStore: rendered, never sent to the model.
        entry: "the saved text",
        previous_entry: "replaced text",
        removed_entry: "removed text",
        keywords: ["deploy", "деплой"],
        project: "pi-hermes-memory",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute(
      "tc-1",
      { action: "add", target: "user", content: "the saved text" },
      undefined as any, undefined as any, undefined as any,
    );

    const parsed = JSON.parse(result.content[0].text);
    for (const field of ["entry", "previous_entry", "removed_entry", "keywords", "project"]) {
      assert.strictEqual(field in parsed, false, `${field} must not reach the model`);
      assert.strictEqual(field in result.details, true, `${field} stays available for the renderer`);
    }
    assert.deepStrictEqual(result.details.keywords, ["deploy", "деплой"]);
    assert.strictEqual(result.details.entry, "the saved text");
  });

  it("execute add with FIFO evictions returns normal text with full rotated entries", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const evictedOne = "First rotated entry with full detail.";
    const evictedTwo = "Second rotated entry with\nmultiple lines preserved.";
    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        entry_count: 1,
        message: "Memory updated. Rotated 2 older entries to stay within the limit.",
        evicted_entries: [evictedOne, evictedTwo],
        evicted_count: 2,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    const text = result.content[0].text;
    assert.throws(() => JSON.parse(text));
    assert.match(text, /Memory updated\. Rotated 2 older entries/);
    assert.match(text, /Rotated active memory entries:/);
    assert.ok(text.includes(`1. ${evictedOne}`));
    assert.ok(text.includes(`2. ${evictedTwo}`));
    assert.match(text, /If one of these entries should stay active, add it again\./);
    assert.deepStrictEqual(result.details.evicted_entries, [evictedOne, evictedTwo]);
  });

  it("syncs successful adds into SQLite", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const results = getMemories(dbManager, { target: 'memory', project: null });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Entry one');
  });

  it("lands over-cap policy-only adds in searchable SQLite", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;
    const store = new MemoryStore({
      memoryMode: "policy-only",
      memoryCharLimit: 40,
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
      memoryDir: tmpDir,
    });
    registerMemoryTool(mockPi, store, null, dbManager);
    await store.loadFromDisk();
    const first = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "alpha entry" }, undefined as any, undefined as any, undefined as any);
    assert.strictEqual(first.details.success, true);
    const second = await capturedResult.execute("tc-2", { action: "add", target: "memory", content: "beta entry past the tiny cap" }, undefined as any, undefined as any, undefined as any);
    assert.strictEqual(second.details.success, true);
    const results = searchMemories(dbManager, "beta entry past the tiny cap", { target: "memory" });
    assert.ok(results.some((r) => r.content.includes("beta entry past the tiny cap")));
  });

  it("reports the matching target when replace is sent to the wrong target", async () => {
    let removeTool: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (def.name === "memory_remove") removeTool = def;
      },
    } as unknown as ExtensionAPI;
    const store = new MemoryStore({
      memoryMode: "policy-only",
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
      memoryDir: tmpDir,
    });
    // SQLite is the only store: the failure entry must land in the database.
    registerMemoryTool(mockPi, store, null, dbManager);
    await store.loadFromDisk();
    await store.addFailure("use pnpm for lockfiles", { category: "correction" });

    const result = await removeTool.execute(
      "tc-1",
      { target: "memory", old_text: "use pnpm for lockfiles" },
      undefined,
      undefined,
      undefined,
    );

    assert.equal(result.details.success, false);
    assert.match(result.details.error, /No match in target "memory"/);
    assert.match(result.details.error, /target "failure"/);
    assert.deepEqual(result.details.matching_targets, ["failure"]);
  });

  it("prunes same-scope SQLite orphans after a Markdown mutation", async () => {
    let capturedResult: any;
    const mockPi = {
    registerTool: (definition: any) => {
      if (!capturedResult || definition.name === "memory_add") capturedResult = definition;
    },
    } as unknown as ExtensionAPI;
    const store = new MemoryStore({
      memoryMode: "policy-only",
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
      memoryDir: tmpDir,
    });
    registerMemoryTool(mockPi, store, null, dbManager);
    await store.loadFromDisk();
    syncMemoryEntry(dbManager, { content: "orphaned row", target: "memory", project: null });

    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "authoritative Markdown row" },
      undefined,
      undefined,
      undefined,
    );

    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: null }).map((entry) => entry.content),
      ["authoritative Markdown row"],
    );
  });

  it("merges a newer concurrent SQLite writer after the mirror write", async () => {
    let capturedResult: any;
    const mockPi = {
    registerTool: (definition: any) => {
      if (!capturedResult || definition.name === "memory_add") capturedResult = definition;
    },
    } as unknown as ExtensionAPI;
    const store = new MemoryStore({
      memoryMode: "policy-only",
      // The mirror is opt-in; this test exercises the mirror-write seam race.
      markdownMirror: true,
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
      memoryDir: tmpDir,
    });
    registerMemoryTool(mockPi, store, null, dbManager);
    await store.loadFromDisk();

    const originalMirror = (store as any).writeMarkdownMirror.bind(store);
    (store as any).writeMarkdownMirror = async (target: "memory") => {
      // Mirror write publishes the authoritative SQLite scope; a concurrent
      // writer then lands a second row straight into SQLite. The SQLite-primary
      // finalize step re-loads the scope, so both rows survive.
      await originalMirror(target);
      const markdownPath = path.join(tmpDir, MEMORY_FILE);
      const existing = fs.readFileSync(markdownPath, "utf-8");
      const date = new Date().toISOString().split("T")[0];
      fs.writeFileSync(markdownPath, `${existing}${ENTRY_DELIMITER}newer writer <!-- created=${date}, last=${date} -->`);
      syncMemoryEntry(dbManager, { content: "newer writer", target: "memory", project: null });
      return null;
    };

    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "first writer" },
      undefined,
      undefined,
      undefined,
    );

    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: null }).map((entry) => entry.content).sort(),
      ["first writer", "newer writer"],
    );
  });

  it("removes FIFO-evicted entries from the SQLite mirror", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    syncMemoryEntry(dbManager, {
      content: "Older entry",
      target: "memory",
      project: null,
    });
    syncMemoryEntry(dbManager, {
      content: "Older entry with extra detail",
      target: "memory",
      project: null,
    });

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Older entry"],
        evicted_count: 1,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    assert.match(result.content[0].text, /Rotated active memory entries:/);
    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.deepStrictEqual(rows.map((row) => row.content).sort(), ["New entry", "Older entry with extra detail"].sort());
  });

  it("uses project scope when removing FIFO-evicted SQLite entries", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    syncMemoryEntry(dbManager, {
      content: "Shared wording",
      target: "memory",
      project: null,
    });
    syncMemoryEntry(dbManager, {
      content: "Shared wording",
      target: "memory",
      project: "project-a",
    });

    const mockProjectStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Project replacement"],
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Shared wording"],
        evicted_count: 1,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, dbManager, "project-a");
    await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project replacement" }, undefined as any, undefined as any, undefined as any);

    const globalRows = getMemories(dbManager, { target: "memory", project: null });
    const projectRows = getMemories(dbManager, { target: "memory", project: "project-a" });
    assert.deepStrictEqual(globalRows.map((row) => row.content), ["Shared wording"]);
    assert.deepStrictEqual(projectRows.map((row) => row.content), ["Project replacement"]);
  });

  it("maps project target to SQLite project scope", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const addTargets: string[] = [];
    const mockProjectStore = {
      add: (target: string) => {
        addTargets.push(target);
        return {
          success: true,
          target,
          entries: ["Project entry"],
          entry_count: 1,
          message: "Entry added.",
        };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, dbManager, 'project-a');
    const result = await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project entry" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.target, 'project');
    assert.strictEqual(result.details.target, 'project');
    assert.deepStrictEqual(addTargets, ['memory']);

    const results = getMemories(dbManager, { project: 'project-a', target: 'memory' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Project entry');
  });

  it("resolves the active project store and name for each mutation", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    let activeProjectName = "project-a";
    const calls: string[] = [];
    const stores = new Map<string, MemoryStore>();
    const makeProjectStore = (name: string) => ({
      add: (target: string, content: string) => {
        calls.push(`${name}:${target}:${content}`);
        return {
          success: true,
          target,
          entries: [content],
          entry_count: 1,
          message: "Entry added.",
        };
      },
    }) as unknown as MemoryStore;
    stores.set("project-a", makeProjectStore("project-a"));
    stores.set("project-b", makeProjectStore("project-b"));

    registerMemoryTool(
      mockPi,
      {} as MemoryStore,
      () => stores.get(activeProjectName) ?? null,
      dbManager,
      () => activeProjectName,
    );

    await capturedResult.execute("tc-1", { target: "project", content: "first" }, undefined as any, undefined as any, undefined as any);
    activeProjectName = "project-b";
    await capturedResult.execute("tc-2", { target: "project", content: "second" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(calls, ["project-a:memory:first", "project-b:memory:second"]);
    const projectRows = getMemories(dbManager, { project: "project-b", target: "memory" });
    assert.deepStrictEqual(projectRows.map((row) => row.content), ["second"]);
  });
  it("reconciles rebound project-store mutations in the project SQLite scope", async () => {
    let activeProjectName = "project-a";
    type MutationObserver = (
      target: "memory" | "user" | "failure",
      entries: string[],
    ) => Promise<string | null | undefined>;
    const observers = new Map<string, MutationObserver>();
    const stores = new Map<string, MemoryStore>();
    const makeProjectStore = (name: string) => ({
      setMutationObserver: (observer: MutationObserver) => {
        observers.set(name, observer);
      },
    }) as unknown as MemoryStore;
    stores.set("project-a", makeProjectStore("project-a"));
    stores.set("project-b", makeProjectStore("project-b"));
    const mockPi = {
      registerTool: () => {},
    } as unknown as ExtensionAPI;

    const configureProjectStore = registerMemoryTool(
      mockPi,
      {} as MemoryStore,
      () => stores.get(activeProjectName) ?? null,
      dbManager,
      () => activeProjectName,
    );

    await observers.get("project-a")?.("memory", ["first project entry"]);
    activeProjectName = "project-b";
    configureProjectStore(stores.get("project-b") ?? null);
    await observers.get("project-b")?.("memory", ["second project entry"]);

    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: "project-a" }).map((row) => row.content),
      ["first project entry"],
    );
    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: "project-b" }).map((row) => row.content),
      ["second project entry"],
    );
    assert.deepStrictEqual(getMemories(dbManager, { target: "memory", project: null }), []);
  });

  it("returns a warning instead of failing when SQLite sync errors", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    const failingDbManager = {
      getDb: () => {
        throw new Error('sqlite unavailable');
      },
    } as unknown as DatabaseManager;

    registerMemoryTool(mockPi, mockStore, null, failingDbManager);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.match(parsed.message, /SQLite search sync failed/);
    assert.match(parsed.warning, /sqlite unavailable/);
  });

  it("does not sync to SQLite when core Markdown add fails", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: false,
        error: "Memory at 5000/5000 chars. Adding this entry would exceed the limit.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "overflow entry" },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);

    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.strictEqual(rows.length, 0, "SQLite should stay unchanged when core add fails");
  });

  it("registers action-specific schemas that reject incomplete mutations", () => {
    const registeredTools: Record<string, any> = {};
    const mockPi = {
      registerTool: (definition: any) => {
        registeredTools[definition.name] = definition;
      },
    } as unknown as ExtensionAPI;

    registerMemoryTool(mockPi, {} as MemoryStore, null);

    assert.deepStrictEqual(Object.keys(registeredTools).sort(), [
      "memory_add",
      "memory_remove",
      "memory_replace",
    ]);
    assert.strictEqual(
      Value.Check(registeredTools.memory_add.parameters, {
        action: "add",
        target: "failure",
        category: "tool-quirk",
        failure_reason: "missing content",
      }),
      false,
      "add without content must fail schema validation",
    );
    assert.strictEqual(
      Value.Check(registeredTools.memory_replace.parameters, {
        target: "memory",
        content: "new",
      }),
      false,
      "replace without old_text must fail schema validation",
    );
    assert.strictEqual(
      Value.Check(registeredTools.memory_remove.parameters, { target: "memory" }),
      false,
      "remove without old_text must fail schema validation",
    );
    assert.strictEqual(
      Value.Check(registeredTools.memory_add.parameters, {
        target: "memory",
        content: "durable fact",
      }),
      true,
    );
    assert.strictEqual(
      Value.Check(registeredTools.memory_replace.parameters, {
        target: "memory",
        old_text: "old",
        content: "new",
      }),
      true,
    );
    assert.strictEqual(
      Value.Check(registeredTools.memory_remove.parameters, {
        target: "memory",
        old_text: "old",
      }),
      true,
    );
  });

  it("execute delegates remove to store.remove", async () => {
    let capturedResult: any;
    let removeArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        if (def.name === "memory_remove") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      remove: (...args: any[]) => {
        removeArgs = args;
        return { success: true, target: "memory", entries: [], entry_count: 0 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { target: "memory", old_text: "old entry" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(removeArgs, ["memory", "old entry"], "should pass target, old_text to store.remove");
  });

  it("execute delegates replace to store.replace", async () => {
    let capturedResult: any;
    let replaceArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        if (def.name === "memory_replace") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      replace: (...args: any[]) => {
        replaceArgs = args;
        return { success: true, target: "memory", entries: ["new"], entry_count: 1 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new", old_text: "old" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(replaceArgs, ["memory", "old", "new"], "should pass target, old_text, content to store.replace");
  });

  it("binds project identity from execute ctx.cwd instead of a factory snapshot", async () => {
    let capturedResult: any;
    const boundCwds: string[] = [];
    const mockPi = {
      registerTool: (def: any) => {
        if (!capturedResult || def.name === "memory_add") capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockProjectStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["from session cwd"],
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(
      mockPi,
      {} as MemoryStore,
      mockProjectStore,
      dbManager,
      "factory-project",
      (cwd) => {
        if (cwd) boundCwds.push(cwd);
      },
    );

    await capturedResult.execute(
      "tc-1",
      { target: "project", content: "from session cwd" },
      undefined,
      undefined,
      { cwd: "/tmp/opened-session-project" },
    );

    assert.deepStrictEqual(boundCwds, ["/tmp/opened-session-project"]);
  });

});
