/**
 * Tests for opt-in FTS5 auto-retrieval (Task 1).
 *
 * Injection is delivered as a custom message (the model sees it as a
 * user-role text block) and the user's own message text is never modified.
 * The transcript renders that message through our renderer: collapsed shows
 * just the entry count + keywords, `app.tools.expand` (ctrl+o) expands it.
 * Only the active project's memories plus global ones are retrieved, each row
 * at most once per session (persisted), with compaction/quit resets.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { syncMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import { getRetrievedMemoryIds } from "../../src/store/retrieval-store.js";
import { setCurrentSessionId } from "../../src/session-id.js";
import {
  setupAutoRetrieve,
  renderRetrievalMessage,
  RETRIEVAL_MESSAGE_TYPE,
} from "../../src/handlers/auto-retrieve.js";
import type { MemoryConfig } from "../../src/types.js";

type Handler = (event: any, ctx: any) => unknown;

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

interface Harness {
  handlers: Record<string, Handler[]>;
  renderers: Record<string, (message: any, options: any, theme: any) => any>;
  ctx: any;
}

/** Fire the before_agent_start hook and return the returned custom message (if any). */
async function fireRetrieval(harness: Harness, prompt: string): Promise<SentMessage | undefined> {
  const handler = harness.handlers.before_agent_start?.[0];
  assert.ok(handler, "before_agent_start handler registered");
  const result = await handler({ type: "before_agent_start", prompt }, harness.ctx) as
    | { message?: SentMessage }
    | undefined;
  return result?.message;
}

const themeStub = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
};

function createHarness(config: MemoryConfig, opts: {
  project?: string;
  cwd?: string;
  sessionId?: string;
} = {}): Harness {
  const handlers: Record<string, Handler[]> = {};
  const renderers: Record<string, (message: any, options: any, theme: any) => any> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerMessageRenderer: (type: string, renderer: (message: any, options: any, theme: any) => any) => {
      renderers[type] = renderer;
    },
  } as any;
  const harness: Harness = {
    handlers,
    renderers,
    ctx: {
      sessionManager: { getSessionId: () => opts.sessionId ?? "test-session" },
      cwd: opts.cwd ?? "/tmp/test-project",
      ui: {},
    },
  };
  setupAutoRetrieve(pi, config, {
    dbManager,
    bindProjectFromCwd: () => {},
    resolveProjectName: () => opts.project ?? "",
  });
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
    content: "deployment runs on kubernetes vault with postgresql databases",
    target: "memory",
    project: null,
    keywords: ["k8s", "kubernetes", "кубернетес", "vault"],
  });
  syncMemoryEntry(dbManager, {
    content: "current project uses a monorepo kubernetes layout",
    target: "memory",
    project: "project-a",
    keywords: ["monorepo", "kubernetes", "layout"],
  });
  syncMemoryEntry(dbManager, {
    content: "other project hides secrets in vault kubernetes config",
    target: "memory",
    project: "project-b",
    keywords: ["vault", "kubernetes", "secrets"],
  });
  syncMemoryEntry(dbManager, {
    content: "do not parallelize database tests, kubernetes vault migrations",
    target: "failure",
    category: "correction",
    keywords: ["tests", "parallelize", "kubernetes", "vault", "параллельно"],
  });
}

const QUERY = "kubernetes monorepo vault parallelize";

describe("auto-retrieve", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-retrieve-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    setCurrentSessionId(undefined);
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function policyOnlyConfig(memoryDir: string): MemoryConfig {
    return baseConfig({
      memoryMode: "policy-only",
      markdownMirror: false,
      memoryDir,
    });
  }

  it("disabled by default — no handlers or renderers are registered", () => {
    const harness = createHarness(baseConfig());
    assert.equal(harness.handlers.before_agent_start, undefined);
    assert.equal(harness.handlers.session_compact, undefined);
    assert.equal(harness.handlers.session_shutdown, undefined);
    assert.equal(Object.keys(harness.renderers).length, 0);
  });

  it("sends the injection as a custom message and never modifies the user text", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });

    const message = await fireRetrieval(harness, QUERY);
    assert.ok(message, "exactly one custom message is returned");
    assert.equal(message.customType, RETRIEVAL_MESSAGE_TYPE);
    assert.equal(message.display, true);
    assert.ok(message.content.includes("<retrieved-memory>"));
    assert.ok(message.content.includes("deployment runs on kubernetes"));
    assert.ok(message.content.includes("[project:project-a] current project uses a monorepo"));
    assert.ok(!message.content.includes("other project hides secrets"), "other projects are excluded");

    const details = message.details as { count: number; keywords: string; entries: unknown[] };
    assert.equal(details.count, 3);
    assert.ok(details.keywords.includes("k8s"));

    // Dedup rows persisted for the session.
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3);
  });

  it("only retrieves active-project and global memories", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-b" });
    const message = await fireRetrieval(harness, QUERY);
    assert.ok(message);
    const details = message.details as { entries: Array<{ project: string | null }> };
    assert.ok(
      details.entries.every((entry) => entry.project === null || entry.project === "project-b"),
      "only global and the active project's entries",
    );
    assert.ok(
      details.entries.some((entry) => entry.project === "project-b"),
      "active project memory is included",
    );
    assert.ok(
      !details.entries.some((entry) => entry.project === "project-a"),
      "another project's memory is excluded",
    );
  });

  it("without an active project only global memories are retrieved", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "" });
    const message = await fireRetrieval(harness, QUERY);
    assert.ok(message);
    const details = message.details as { entries: Array<{ project: string | null }> };
    assert.ok(details.entries.every((entry) => entry.project === null), "no project-scoped entries");
  });

  it("never re-injects the same ids in a session (persisted dedup, strict once)", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    assert.ok(await fireRetrieval(harness, QUERY));

    const second = await fireRetrieval(harness, "kubernetes monorepo vault parallelize again");
    assert.equal(second, undefined, "no re-injection when all matches were already shown");

    // A "new process" (fresh handler, same DB) sees the persisted rows.
    const restarted = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    assert.equal(await fireRetrieval(restarted, QUERY), undefined, "persisted dedup survives process restarts");
  });

  it("compaction resets the session dedup so facts are injected once more", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    assert.ok(await fireRetrieval(harness, QUERY));
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3);

    await harness.handlers.session_compact[0]({ type: "session_compact" }, harness.ctx);
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 0, "compaction clears dedup");

    assert.ok(await fireRetrieval(harness, QUERY), "re-injection allowed after compaction");
  });

  it("does not clear dedup on session end (quit/resume keep it)", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    assert.ok(await fireRetrieval(harness, QUERY));
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3);

    // No shutdown cleanup is registered at all: a resumed session reuses the
    // same session id, so its dedup rows must survive pi restarts (otherwise
    // every exit+resume re-floods the same facts).
    assert.equal(harness.handlers.session_shutdown, undefined, "no session_shutdown cleanup handler");
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 3, "dedup survives session end");
  });

  it("skips short queries, slash commands and background prompts", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    const cases = [
      "hi",
      "/memory-insights",
      "Review the conversation above and save what matters",
      "[System: The session is being compressed — save interesting facts",
    ];
    for (const text of cases) {
      const result = await fireRetrieval(harness, text);
      assert.equal(result, undefined, `should skip: ${text.slice(0, 40)}`);
    }
    assert.equal(getRetrievedMemoryIds(dbManager, "test-session").size, 0);
  });

  it("targets filter restricts which memories are retrieved", async () => {
    seedMemories();
    const harness = createHarness(
      baseConfig({ autoRetrieve: { enabled: true, targets: ["failure"] } }),
      { project: "project-a" },
    );
    const message = await fireRetrieval(harness, QUERY);
    assert.ok(message);
    const details = message.details as { entries: Array<{ target: string }> };
    assert.ok(details.entries.every((entry) => entry.target === "failure"));
  });

  it("renderer shows count + keywords collapsed and the full block expanded", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    const message = await fireRetrieval(harness, QUERY);
    assert.ok(message);

    const renderer = harness.renderers[RETRIEVAL_MESSAGE_TYPE];
    assert.ok(renderer, "renderer registered for the retrieval message type");

    const collapsed = renderer(message, { expanded: false }, themeStub).render(120).join("\n");
    assert.match(collapsed, /Retrieved 3 entries/);
    assert.ok(collapsed.includes("k8s"));
    assert.ok(collapsed.includes("in: kubernetes"), "collapsed header shows trigger words");
    assert.match(collapsed, /ctrl\+o to expand/);
    assert.ok(!collapsed.includes("current project uses a monorepo"), "collapsed hides the full content");

    const expanded = renderer(message, { expanded: true }, themeStub).render(120).join("\n");
    assert.ok(expanded.includes("current project uses a **monorepo**"));
    assert.ok(expanded.includes("**monorepo**"), "matched terms are bolded in the expanded block");
    assert.ok(expanded.includes("[project:project-a]"));
    assert.ok(!expanded.includes("to expand"));
  });

  it("marks freshly written memories as already injected for the session", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });

    // Real write path: registerMemoryTool wires the session provider + writer.
    const { registerMemoryTool } = await import("../../src/tools/memory-tool.js");
    const store = new MemoryStore(policyOnlyConfig(tmpDir));
    let addTool: any;
    const toolPi = {
      registerTool: (def: any) => { if (def.name === "memory_add") addTool = def; },
    } as any;
    registerMemoryTool(toolPi, store, null, dbManager);
    await store.loadFromDisk();
    setCurrentSessionId("test-session");
    await addTool.execute(
      "tc-1",
      { target: "memory", content: "freshly written fact about deploy", keywords: ["deploy", "новый"] },
      undefined, undefined, undefined,
    );

    // Auto-retrieval must not re-inject the just-written fact.
    const message = await fireRetrieval(harness, "freshly deploy kubernetes monorepo vault parallelize");
    assert.ok(message);
    const details = message.details as { entries: Array<{ content: string }> };
    assert.ok(
      details.entries.every((entry) => !entry.content.includes("freshly written fact")),
      "just-written fact is marked as injected and not re-injected",
    );
    assert.ok(
      details.entries.some((entry) => entry.content.includes("deployment runs on kubernetes")),
      "older facts are still retrieved",
    );

    // The row id is in the persisted dedup.
    const rows = dbManager.getDb().prepare("SELECT id FROM memories WHERE content LIKE 'freshly written%'").all() as Array<{ id: number }>;
    assert.equal(rows.length, 1);
    const marked = getRetrievedMemoryIds(dbManager, "test-session");
    assert.ok(marked.has(rows[0].id), "fresh row is marked as retrieved for the session");

    // Without a session the write is not attributed (no crash).
    setCurrentSessionId(undefined);
    await addTool.execute(
      "tc-2",
      { target: "memory", content: "unattributed fact" },
      undefined, undefined, undefined,
    );
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("unattributed fact")));
  });

  it("store-level: fresh adds/replaces flush to the injected writer", async () => {
    const store = new MemoryStore(policyOnlyConfig(tmpDir));
    const writtenByTarget: Record<string, string[]> = {};
    store.setSqlitePrimaryWriter(async (target, entries) => { writtenByTarget[target] = entries; return null; });
    store.setSqliteScopeLoader(async (target) => writtenByTarget[target] ?? []);
    const marked: Array<{ target: string; raws: string[] }> = [];
    store.setSessionIdProvider(() => "session-x");
    store.setInjectedWriter((target, raws) => { marked.push({ target, raws: [...raws] }); });
    await store.loadFromDisk();

    await store.add("memory", "added fact", undefined, { keywords: ["kw"] });
    assert.equal(marked.length, 1);
    assert.equal(marked[0].target, "memory");
    assert.ok(marked[0].raws[0].includes("added fact"));
    assert.ok(marked[0].raws[0].includes("keys=kw"));

    await store.replace("memory", "added fact", "replaced fact");
    assert.equal(marked.length, 2);
    assert.ok(marked[1].raws[0].includes("replaced fact"));

    marked.length = 0;
    await store.applyMutationPlan("memory", [
      { action: "add", content: "plan added one", keywords: ["p1"] },
      { action: "add", content: "plan added two" },
    ]);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].raws.length, 2);

    // No session → the queue is dropped silently.
    store.setSessionIdProvider(() => undefined);
    marked.length = 0;
    const result = await store.add("memory", "no-session write");
    assert.equal(result.success, true);
    assert.equal(marked.length, 0);
  });

  it("lazy isReady guard skips retrieval until initialization", async () => {
    seedMemories();
    let ready = false;
    const handlers2: Record<string, Handler[]> = {};
    const pi2 = {
      on: (event: string, handler: Handler) => { (handlers2[event] ??= []).push(handler); },
      registerMessageRenderer: () => {},
    } as any;
    const ctx2 = {
      sessionManager: { getSessionId: () => "test-session" },
      cwd: "/tmp/test-project",
    };
    setupAutoRetrieve(pi2, baseConfig({ autoRetrieve: { enabled: true } }), {
      dbManager,
      isReady: () => ready,
      resolveProjectName: () => "project-a",
    });

    const skipped = await handlers2.before_agent_start[0]({ type: "before_agent_start", prompt: QUERY }, ctx2);
    assert.equal(skipped, undefined, "lazy-not-ready skips");

    ready = true;
    const injected = await handlers2.before_agent_start[0]({ type: "before_agent_start", prompt: QUERY }, ctx2) as any;
    assert.ok(injected?.message, "after initialization retrieval runs");
  });
  it("carries trigger terms and per-entry matched terms in details", async () => {
    seedMemories();
    const harness = createHarness(baseConfig({ autoRetrieve: { enabled: true } }), { project: "project-a" });
    const message = (await fireRetrieval(harness, QUERY))!;
    const details = message.details as {
      triggers: string[];
      entries: Array<{ matchedTerms: string[]; content: string }>;
    };
    assert.deepStrictEqual([...details.triggers].sort(), ["kubernetes", "monorepo", "parallelize", "vault"], "triggers are the terms that actually matched");
    const globalEntry = details.entries.find((e) => e.content.includes("deployment runs on kubernetes"))!;
    assert.ok(globalEntry.matchedTerms.includes("kubernetes"));
    assert.ok(globalEntry.matchedTerms.includes("vault"));
    for (const entry of details.entries) {
      for (const term of entry.matchedTerms) {
        assert.ok(details.triggers.includes(term), `trigger list carries the bolded term: ${term}`);
      }
    }
  });

  it("minMatchedTerms raises the relevance bar", async () => {
    seedMemories();
    const harness = createHarness(
      baseConfig({ autoRetrieve: { enabled: true, minMatchedTerms: 3 } }),
      { project: "project-a" },
    );
    const message = await fireRetrieval(harness, QUERY);
    assert.ok(message, "failure entry matches 3 terms and is still injected");
    const details = message.details as { count: number; entries: Array<{ content: string }> };
    assert.equal(details.count, 1, "only the 3-term failure entry passes");
    assert.ok(details.entries[0].content.includes("parallelize database tests"));
  });
});