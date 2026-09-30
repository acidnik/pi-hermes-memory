import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { getImportantMemories, syncMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import { getRetrievedMemoryIds } from "../../src/store/retrieval-store.js";
import {
  IMPORTANT_MEMORY_TYPE,
  registerMemoryPinCommand,
  renderImportantBlock,
  setupImportantMemory,
} from "../../src/handlers/important-memory.js";

describe("important memory", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "important-memory-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fires before_agent_start like pi does and returns the produced message. */
  function harness(project = "") {
    const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
    const pi = {
      on: (event: string, handler: (e: any, c: any) => any) => {
        (handlers[event] ??= []).push(handler);
      },
    } as any;
    setupImportantMemory(pi, {
      dbManager,
      bindProjectFromCwd: async () => {},
      resolveProjectName: () => project,
    });
    return async (sessionId: string): Promise<any> => {
      let result: any;
      const ctx = {
        cwd: "/tmp",
        sessionManager: { getSessionId: () => sessionId },
        ui: { notify() {} },
      };
      for (const handler of handlers["before_agent_start"] ?? []) {
        result = (await handler({}, ctx)) ?? result;
      }
      return result;
    };
  }

  it("injects the pool once per session as a hidden tail block", async () => {
    syncMemoryEntry(dbManager, { content: "always ask before deployment", target: "memory", important: true });
    syncMemoryEntry(dbManager, { content: "plain fact", target: "memory", keywords: ["plain"] });

    const fire = harness();
    const first = await fire("session-1");
    assert.ok(first?.message, "returns a custom message on the first turn");
    assert.equal(first.message.customType, IMPORTANT_MEMORY_TYPE);
    assert.equal(first.message.display, false, "hidden from the transcript");
    assert.match(first.message.content, /<important-memory>/);
    assert.match(first.message.content, /always ask before deployment/);
    assert.doesNotMatch(first.message.content, /plain fact/, "non-important entries are not injected");
    assert.equal(getRetrievedMemoryIds(dbManager, "session-1").size, 1, "marked as injected for retrieval dedup");

    assert.equal(await fire("session-1"), undefined, "only once per session");
    assert.ok(await fire("session-2"), "a new session gets the pool again");
  });

  it("never leaks another project's always-injected entries", async () => {
    syncMemoryEntry(dbManager, { content: "global rule", target: "memory", important: true });
    syncMemoryEntry(dbManager, {
      content: "project-a rule",
      target: "memory",
      project: "project-a",
      important: true,
    });

    const fired = await harness("project-b")("session-3");
    assert.match(fired.message.content, /global rule/);
    assert.doesNotMatch(fired.message.content, /project-a rule/);
  });

  it("says nothing when the pool is empty", async () => {
    assert.equal(await harness()("session-4"), undefined);
    assert.match(renderImportantBlock([]), /^<important-memory>/);
  });

  it("gives the user a /memory-pin view over the pool", async () => {
    const notifications: string[] = [];
    const commands: Record<string, any> = {};
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: any) => { commands[name] = options; },
    } as any;
    registerMemoryPinCommand(pi, dbManager);
    const ctx = { ui: { notify: (text: string) => notifications.push(text) } } as any;

    await commands["memory-pin"].handler("never run rm -rf /", ctx);
    assert.equal(getImportantMemories(dbManager).length, 1);
    assert.match(notifications.at(-1)!, /Pinned \(1 total/);

    await commands["memory-pin"].handler("", ctx);
    assert.match(notifications.at(-1)!, /1 always-injected entry/);
    assert.match(notifications.at(-1)!, /never run rm -rf \//);

    await commands["memory-pin"].handler("remove 1", ctx);
    assert.equal(getImportantMemories(dbManager).length, 0);
    assert.match(notifications.at(-1)!, /Unpinned: never run rm -rf \//);

    await commands["memory-pin"].handler("another rule", ctx);
    await commands["memory-pin"].handler("clear", ctx);
    assert.equal(getImportantMemories(dbManager).length, 0);
    assert.match(notifications.at(-1)!, /Cleared 1 pinned entry/);

    await commands["memory-pin"].handler("", ctx);
    assert.match(notifications.at(-1)!, /Nothing pinned/);
  });
});
