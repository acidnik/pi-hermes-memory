/**
 * Tests for opt-in memory retrieval on bash tool calls.
 *
 * When enabled, the model's bash command is reduced to search terms (command
 * names, relative paths/filenames; `-`- and `/`-prefixed tokens dropped) and
 * the top-K memory matches are appended to the tool result content, so the
 * model sees them right after the tool output. Dedup is shared with
 * auto-retrieve: each row is injected at most once per session across both
 * features (persisted in `retrieved_memories`), reset by compaction/quit.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { syncMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import {
  setupBashRetrieve,
  extractCommandTerms,
  renderBashRetrieveBlock,
} from "../../src/handlers/bash-retrieve.js";
import type { MemoryConfig } from "../../src/types.js";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
  handlers: Record<string, Handler[]>;
  ctx: any;
}

/** Fire the tool_result hook and return the returned patch (if any). */
async function fireToolResult(
  harness: Harness,
  event: { toolName: string; input: Record<string, unknown>; content?: unknown[] },
): Promise<{ content?: unknown[] } | undefined> {
  const handler = harness.handlers.tool_result?.[0];
  assert.ok(handler, "tool_result handler registered");
  return await handler(
    {
      type: "tool_result",
      toolCallId: "call-1",
      isError: false,
      content: event.content ?? [{ type: "text", text: "command output" }],
      ...event,
    },
    harness.ctx,
  ) as { content?: unknown[] } | undefined;
}

function createHarness(config: MemoryConfig, opts: {
  project?: string;
  cwd?: string;
  sessionId?: string;
  ready?: boolean;
} = {}): Harness {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
  } as any;
  const harness: Harness = {
    handlers,
    ctx: {
      sessionManager: { getSessionId: () => opts.sessionId ?? "test-session" },
      cwd: opts.cwd ?? "/tmp/test-project",
      ui: {},
    },
  };
  setupBashRetrieve(pi, config, {
    dbManager,
    isReady: opts.ready === undefined ? undefined : () => opts.ready!,
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
    content: "npm run build runs the full type check before the test suite",
    target: "memory",
    project: null,
    keywords: ["npm", "build"],
  });
  syncMemoryEntry(dbManager, {
    content: "start the api server with docker compose up in the project root",
    target: "memory",
    project: "project-a",
    keywords: ["docker", "compose"],
  });
  syncMemoryEntry(dbManager, {
    content: "other project's ci deploys with a different toolchain",
    target: "memory",
    project: "project-b",
    keywords: ["ci"],
  });
  syncMemoryEntry(dbManager, {
    content: "do not run sqlite migrations while the api is live",
    target: "failure",
    category: "correction",
    keywords: ["sqlite", "migrations"],
  });
}

describe("extractCommandTerms", () => {
  it("keeps command names and drops flags and absolute paths", () => {
    assert.deepStrictEqual(extractCommandTerms("ls -la /var/log"), ["ls"]);
    assert.deepStrictEqual(extractCommandTerms("npm run build -- --watch"), ["npm", "run", "build"]);
    assert.deepStrictEqual(extractCommandTerms("rg -n foo src/store/db.ts"), ["rg", "foo", "db.ts"]);
  });

  it("drops shell syntax, env assignments and modifiers", () => {
    assert.deepStrictEqual(extractCommandTerms("cd src && npm run build"), ["src", "npm", "run", "build"]);
    assert.deepStrictEqual(extractCommandTerms("FOO=bar npm test"), ["npm", "test"]);
    assert.deepStrictEqual(extractCommandTerms("sudo systemctl restart postgresql"), ["systemctl", "restart", "postgresql"]);
    assert.deepStrictEqual(extractCommandTerms("build 2>&1 | tee log.txt"), ["build", "tee", "log.txt"]);
  });

  it("returns no terms for flag-only/key-only commands", () => {
    assert.deepStrictEqual(extractCommandTerms("echo $PATH"), []);
    assert.deepStrictEqual(extractCommandTerms("-la"), []);
    assert.deepStrictEqual(extractCommandTerms("/usr/bin/ls"), []);
    assert.deepStrictEqual(extractCommandTerms(""), []);
    assert.deepStrictEqual(extractCommandTerms("x"), []);
  });

  it("derives basename and extension stems from relative paths", () => {
    assert.deepStrictEqual(extractCommandTerms("cat src/store/sqlite-memory-store.ts"), [
      "cat", "sqlite-memory-store.ts", "sqlite-memory-store",
    ]);
    assert.ok(extractCommandTerms("open package.json").includes("package"));
  });

  it("deduplicates case-insensitively and caps at 10 terms", () => {
    const dupes = extractCommandTerms("Npm NPM npm test TEST");
    assert.deepStrictEqual(dupes, ["npm", "test"]);
    const capped = extractCommandTerms("one two three four five six seven eight nine ten eleven twelve");
    assert.strictEqual(capped.length, 10);
  });
});

describe("renderBashRetrieveBlock", () => {
  it("wraps entries in the retrieved-memory marker with scope labels", () => {
    const block = renderBashRetrieveBlock([
      syncMemoryEntry(dbManager, {
        content: "npm run build runs the full type check",
        target: "memory",
        project: null,
      }).entry,
      syncMemoryEntry(dbManager, {
        content: "api lives in the repo root",
        target: "memory",
        project: "project-a",
      }).entry,
      syncMemoryEntry(dbManager, {
        content: "never migrate while live",
        target: "failure",
        category: "correction",
      }).entry,
    ]);
    assert.ok(block.startsWith("<retrieved-memory>"));
    assert.ok(block.endsWith("</retrieved-memory>"));
    assert.ok(block.includes("- [memory] npm run build"));
    assert.ok(block.includes("- [project:project-a] api lives"));
    assert.ok(block.includes("- [failure:correction] never migrate"));
  });
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-retrieve-"));
  dbManager = new DatabaseManager(tmpDir);
  seedMemories();
});

afterEach(() => {
  if (dbManager) dbManager.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("setupBashRetrieve", () => {

  it("registers no tool_result handler when disabled", () => {
    const harness = createHarness(baseConfig());
    assert.strictEqual(harness.handlers.tool_result, undefined);
  });

  it("appends a memory block to the bash tool result", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.ok(patch, "expected a content patch");
    const content = patch!.content!;
    assert.ok(Array.isArray(content));
    // Original tool output preserved, memory block appended after it.
    assert.strictEqual((content[0] as { type: string }).type, "text");
    const block = content[content.length - 1] as { text: string };
    assert.ok(block.text.includes("<retrieved-memory>"));
    assert.ok(block.text.includes("npm run build runs the full type check"));
  });

  it("does nothing for non-bash tool results", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const patch = await fireToolResult(harness, {
      toolName: "read",
      input: { path: "/tmp/file.ts" },
    });
    assert.strictEqual(patch, undefined);
  });

  it("does not inject when the command has no searchable terms", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "echo $PATH" },
    });
    assert.strictEqual(patch, undefined);
  });

  it("does not inject when nothing matches", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "frobnicate the zorp" },
    });
    assert.strictEqual(patch, undefined);
  });

  it("scopes retrieval to the active project plus global", async () => {
    const harnessA = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const patch = await fireToolResult(harnessA, {
      toolName: "bash",
      input: { command: "docker compose up" },
    });
    const text = (patch!.content!.at(-1) as { text: string }).text;
    assert.ok(text.includes("docker compose up in the project root"));
    assert.ok(!text.includes("other project"));
  });

  it("honors the targets config", async () => {
    const harness = createHarness(
      baseConfig({ bashRetrieve: { enabled: true, targets: ["failure"] } }),
      { project: "project-a" },
    );
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "sqlite migrations" },
    });
    const text = (patch!.content!.at(-1) as { text: string }).text;
    assert.ok(text.includes("do not run sqlite migrations"));
    assert.ok(!text.includes("npm run build"));
  });

  it("honors minTerms", async () => {
    const harness = createHarness(
      baseConfig({ bashRetrieve: { enabled: true, minTerms: 3 } }),
      { project: "project-a" },
    );
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm test" },
    });
    assert.strictEqual(patch, undefined);
  });

  it("skips retrieval until isReady", async () => {
    const harness = createHarness(
      baseConfig({ bashRetrieve: { enabled: true } }),
      { project: "project-a", ready: false },
    );
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.strictEqual(patch, undefined);
  });

  it("applies maxChars budget", async () => {
    const harness = createHarness(
      baseConfig({ bashRetrieve: { enabled: true, maxChars: 60 } }),
      { project: "project-a" },
    );
    const patch = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build docker compose" },
    });
    // Two long entries far exceed the budget; the first is unconditionally
    // kept but the second must be dropped, so the block has exactly one entry.
    const text = (patch!.content!.at(-1) as { text: string }).text;
    assert.strictEqual(text.split("- [").length - 1, 1, "budget keeps at most one entry");
  });

  it("does not re-inject the same rows on repeated commands (shared dedup)", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const first = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.ok(first, "first command injects a block");
    // Same command again: every matching row is already marked as retrieved.
    const second = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.strictEqual(second, undefined);
  });

  it("still injects rows matched by a different command", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const first = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.ok(first, "first command injects a block");
    const second = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "docker compose up" },
    });
    const text = (second!.content!.at(-1) as { text: string }).text;
    assert.ok(text.includes("start the api server with docker compose up"));
    assert.ok(!text.includes("npm run build"));
  });

  it("resets dedup after compaction, so rows become injectable again", async () => {
    const harness = createHarness(baseConfig({ bashRetrieve: { enabled: true } }), { project: "project-a" });
    const first = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.ok(first, "first command injects a block");

    const compact = harness.handlers.session_compact?.[0];
    assert.ok(compact, "session_compact handler registered");
    compact({ type: "session_compact" }, harness.ctx);

    const after = await fireToolResult(harness, {
      toolName: "bash",
      input: { command: "npm run build" },
    });
    assert.ok(after, "after compaction the same rows are injected again");
  });
});