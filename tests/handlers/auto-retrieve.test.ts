/**
 * Tests for opt-in FTS5 auto-retrieval (Task 1): memory matches are appended
 * after the user text (cache-safe), each memory row is injected at most once
 * per session (persisted dedup), compaction and session quit reset the rule,
 * and an interactive widget reflects the last injection.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { syncMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import { getRetrievedMemoryIds } from "../../src/store/retrieval-store.js";
import { setupAutoRetrieve } from "../../src/handlers/auto-retrieve.js";
import type { MemoryConfig } from "../../src/types.js";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
  handlers: Record<string, Handler[]>;
  shortcuts: Array<{ key: string; handler: (ctx: any) => void }>;
  widget: string[] | undefined;
  ctx: any;
}

function createHarness(config: MemoryConfig, ctxOverrides: Record<string, unknown> = {}): Harness {
  const handlers: Record<string, Handler[]> = {};
  const shortcuts: Array<{ key: string; handler: (ctx: any) => void }> = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerShortcut: (key: string, opts: { handler: (ctx: any) => void }) => {
      shortcuts.push({ key, handler: opts.handler });
    },
  } as any;
  const harness: Harness = {
    handlers,
    shortcuts,
    widget: undefined,
    ctx: {
      sessionManager: { getSessionId: () => "test-session" },
      ui: { setWidget: (key: string, content: string[] | undefined) => { harness.widget = content; } },
      cwd: "/tmp/test-project",
      ...ctxOverrides,
    },
  };
  setupAutoRetrieve(pi, config, { dbManager, pruneOnStartup: false } as any);
  return harness;
}

let tmpDir: string;
let dbManager: DatabaseManager;

function baseConfig(overrides: Record<string, unknown> = {}): MemoryConfig {
  return {
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
    ...overrides,
  } as MemoryConfig;
}

function seedMemories(): void {
  syncMemoryEntry(dbManager, {
    content: "deployment runs on kubernetes with postgresql databases",
    target: "memory",
    keywords: ["k8s", "кубернетес", "инфраструктура"],
  });
  syncMemoryEntry(dbManager, {
    content: "do not parallelize database tests",
    target: "failure",
    category: "correction",
    keywords: ["tests", "parallel", "база данных"],
  });
  syncMemoryEntry(dbManager, {
    content: "prefers rust over python for cli tools",
    target: "user",
    keywords: ["язык", "rust", "python"],
  });
}

const QUERY = "kubernetes parallelize rust";

describe("auto-retrieve", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-retrieve-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("disabled by default — no handlers or shortcuts are registered", () => {
    const harness = createHarness(baseConfig());
    assert.equal(harness.handlers.input, undefined);
    assert.equal(harness.handlers.session_compact, undefined);
    assert.equal(harness.handlers.session_shutdown, undefined);
    assert.equal(harness.shortcuts.length, 0);
  });

  it("appends top-K matches after the user text and records the dedup ids", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    const result = await harness.handlers.input[0](
      { type: "input", text: QUERY, source: "interactive" },
      harness.ctx,
    );

    assert.ok(result, "should return a transform");
    assert.equal(result.action, "transform");
    assert.ok(result.text.includes(QUERY), "original user text preserved at the start");
    const injectedPart = result.text.slice(QUERY.length);
    assert.ok(injectedPart.includes("<retrieved-memory>"));
    assert.ok(injectedPart.includes("deployment runs on kubernetes"));
    // The injected ids are persisted for the session.
    const injectedIds = getRetrievedMemoryIds(dbManager, "test-session");
    assert.equal(injectedIds.size, 3);

    // Widget shows the collapsed summary (count + keywords).
    assert.ok(harness.widget, "widget should be set");
    assert.match(harness.widget.join("\n"), /Retrieved 3 memory entries/);
    assert.ok(harness.widget.join("\n").includes("k8s"));
    assert.ok(harness.widget.join("\n").includes("кубернетес"));
  });

  it("never re-injects the same ids in a session (persisted dedup, strict once)", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    const first = await harness.handlers.input[0](
      { type: "input", text: QUERY, source: "interactive" },
      harness.ctx,
    );
    assert.equal(first.action, "transform");

    // Same/similar query in the same session: everything already injected.
    const second = await harness.handlers.input[0](
      { type: "input", text: "we still need to deploy kubernetes infrastructure", source: "interactive" },
      harness.ctx,
    );
    assert.equal(second, undefined, "no re-injection when all top matches were already shown");

    // A "new process" (fresh handler, same DB) sees the persisted rows.
    const restarted = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    const third = await restarted.handlers.input[0](
      { type: "input", text: QUERY, source: "interactive" },
      restarted.ctx,
    );
    assert.equal(third, undefined, "persisted dedup survives process restarts");
  });

  it("compaction resets the session dedup so facts are injected once more", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    const first = await harness.handlers.input[0](
      { type: "input", text: QUERY, source: "interactive" },
      harness.ctx,
    );
    assert.equal(first.action, "transform");
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3);

    await harness.handlers.session_compact[0]({ type: "session_compact" }, harness.ctx);
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 0, "compaction clears dedup");
    // Not injected twice within the same turn sequence — but after compaction
    // the same facts are eligible again.
    const after = await harness.handlers.input[0](
      { type: "input", text: QUERY, source: "interactive" },
      harness.ctx,
    );
    assert.ok(after, "re-injection allowed after compaction");
    assert.match(after.text, /deployment runs on kubernetes/);
  });

  it("quit clears dedup; reload keeps it", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    await harness.handlers.input[0]({ type: "input", text: QUERY, source: "interactive" }, harness.ctx);
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3);

    // Reload (same session continues) keeps the rows.
    await harness.handlers.session_shutdown[0]({ type: "session_shutdown", reason: "reload" }, harness.ctx);
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3, "reload keeps dedup");

    // Quit drops them — a resumed session may inject again.
    const harness2 = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3);
    await harness2.handlers.session_shutdown[0]({ type: "session_shutdown", reason: "quit" }, harness.ctx);
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 0, "quit clears dedup");
  });

  it("skips short queries, slash commands and background prompts", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    const cases = [
      "hi",                                                    // < minQueryChars
      "/memory-insights",                                      // command
      "Review the conversation above and save what matters",   // background review
      "[System: The session is being compressed — save interesting facts", // flush
    ];
    for (const text of cases) {
      const result = await harness.handlers.input[0](
        { type: "input", text, source: "interactive" },
        harness.ctx,
      );
      assert.equal(result, undefined, `should skip: ${text.slice(0, 40)}`);
    }
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 0);
  });

  it("targets filter restricts which memories are retrieved", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({
      autoRetrieve: { enabled: true, targets: ["failure"] },
    }));
    const result = await harness.handlers.input[0](
      { type: "input", text: QUERY, source: "interactive" },
      harness.ctx,
    );
    assert.ok(result);
    assert.ok(result.text.includes("[failure:correction] do not parallelize database tests"));
    assert.ok(!result.text.includes("deployment runs on kubernetes"));
  });

  it("ctrl+o toggles the widget between collapsed and expanded", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }));
    await harness.handlers.input[0]({ type: "input", text: QUERY, source: "interactive" }, harness.ctx);
    assert.match(harness.widget!.join("\n"), /ctrl\+o to expand/);

    const shortcut = harness.shortcuts.find((s) => s.key === "ctrl+o");
    assert.ok(shortcut, "ctrl+o shortcut registered");
    shortcut!.handler(harness.ctx);
    assert.match(harness.widget!.join("\n"), /deployment runs on kubernetes/, "expanded shows the full injection");
    assert.match(harness.widget!.join("\n"), /ctrl\+o to collapse/);

    shortcut!.handler(harness.ctx);
    assert.match(harness.widget!.join("\n"), /ctrl\+o to expand/, "second press collapses again");
  });

  it("lazy isReady guard skips retrieval until initialization", async () => {
    seedMemories();
    let ready = false;
    const handlers2: Record<string, Handler[]> = {};
    const widgets: string[] | undefined = undefined;
    const ctx2 = {
      sessionManager: { getSessionId: () => "test-session" },
      ui: { setWidget: () => widgets },
      cwd: "/tmp/test-project",
    };
    const pi2 = {
      on: (e: string, h: Handler) => { (handlers2[e] ??= []).push(h); },
      registerShortcut: () => {},
    } as any;
    setupAutoRetrieve(pi2, baseConfig({ autoRetrieve: { enabled: true } }), {
      dbManager,
      isReady: () => ready,
    });

    const skipped = await handlers2.input[0]({ type: "input", text: QUERY, source: "interactive" }, ctx2);
    assert.equal(skipped, undefined, "lazy-not-ready skips");

    ready = true;
    const injected = await handlers2.input[0]({ type: "input", text: QUERY, source: "interactive" }, ctx2);
    assert.ok(injected, "after initialization the transform runs");
    assert.match(injected.text, /deployment runs on kubernetes/);
  });
});