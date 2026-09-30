/**
 * Always-injected memory — entries flagged `important: true`.
 *
 * These are the facts the model itself promoted because keywords cannot be
 * relied on ("useful in every session, critical, hard to retrieve"). They are
 * injected ONCE at the start of every session:
 *
 * - delivery: a custom message returned from `before_agent_start`, i.e. the LAST
 *   block of that turn's context. Appending at the tail keeps the prefix cache
 *   intact even when the pool changes mid-session (a system-prompt block would
 *   invalidate the whole conversation);
 * - visibility: `display: false` — the block is for the model, not for the
 *   transcript. `/memory-pin` and `memory_search({ important: true })` list the
 *   pool for humans;
 * - scope: global rows plus the ACTIVE project's rows only, exactly like
 *   retrieval, so another project's always-injected facts never leak in;
 * - idempotence: the same retrieved-memories dedup table as auto-retrieve, so
 *   the block is sent once per session, comes back after a context compaction
 *   (which clears the table) and is not re-sent on a plain resume;
 * - budget: SOFT. Nothing is rejected; `memory_add`/`memory_replace` warn in the
 *   tool card when the pool grows past IMPORTANT_POOL_WARN_*.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseManager } from "../store/db.js";
import { formatRetrievalLine } from "./auto-retrieve.js";
import { getImportantMemories, removeMemory, syncMemoryEntry, type SqliteMemoryEntry } from "../store/sqlite-memory-store.js";
import { getRetrievedMemoryIds, markRetrievedMemoryIds } from "../store/retrieval-store.js";

export const IMPORTANT_MEMORY_TYPE = "important-memory";

export interface ImportantMemoryOptions {
  dbManager: DatabaseManager | null;
  /** Lazy-startup guard: skip until memory is initialized (like retrieval). */
  isReady?: () => boolean;
  bindProjectFromCwd?: (cwd?: string) => void | Promise<void>;
  resolveProjectName?: () => string;
}

/** The text block the model receives at the start of a session. */
export function renderImportantBlock(entries: SqliteMemoryEntry[]): string {
  return [
    "<important-memory>",
    "Always-injected facts for this session's scope (promoted with important:true):",
    ...entries.map((entry) => formatRetrievalLine(entry)),
    "</important-memory>",
  ].join("\n");
}

function sessionIdOf(ctx: ExtensionContext | undefined): string | undefined {
  const manager = ctx?.sessionManager;
  return typeof manager?.getSessionId === "function" ? manager.getSessionId() : undefined;
}

export function setupImportantMemory(pi: ExtensionAPI, options: ImportantMemoryOptions): void {
  if (typeof pi.on !== "function") return;
  const { dbManager, isReady, bindProjectFromCwd, resolveProjectName } = options;

  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      if (!dbManager) return;
      if (isReady && !isReady()) return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;

      await bindProjectFromCwd?.((ctx as { cwd?: string }).cwd);
      const activeProject = (resolveProjectName?.() ?? "").trim();
      const projects: Array<string | null> = activeProject ? [null, activeProject] : [null];
      const entries = getImportantMemories(dbManager, { projects });
      if (entries.length === 0) return;

      const alreadyInjected = getRetrievedMemoryIds(dbManager, sessionId);
      if (entries.every((entry) => alreadyInjected.has(entry.id))) return;
      markRetrievedMemoryIds(dbManager, sessionId, entries.map((entry) => entry.id));

      return {
        message: {
          customType: IMPORTANT_MEMORY_TYPE,
          content: renderImportantBlock(entries),
          display: false,
          details: {
            count: entries.length,
            entries: entries.map((entry) => ({
              target: entry.target,
              project: entry.project,
              category: entry.category,
              content: entry.content,
            })),
          },
        },
      };
    } catch {
      // Never break the user's prompt.
      return;
    }
  });
}

/**
 * One-time fold of the retired Standing instructions file into the SQLite
 * always-injected pool. Idempotent: a `standing_migrated` marker in
 * extension_metadata makes it a no-op afterwards. The file itself is left on
 * disk untouched (inert backup, like the other retired Markdown stores).
 */
export function migrateStandingInstructions(
  dbManager: DatabaseManager,
  candidatePaths: Array<string | null | undefined>,
): number {
  const db = dbManager.getDb();
  const marker = db
    .prepare("SELECT value FROM extension_metadata WHERE key = 'standing_migrated'")
    .get() as { value?: string } | undefined;
  if (marker) return 0;

  let imported = 0;
  const file = candidatePaths.find((candidate): candidate is string => Boolean(candidate));
  if (file && fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf-8");
    for (const instruction of parseStandingInstructions(raw)) {
      syncMemoryEntry(dbManager, { content: instruction, target: "memory", important: true });
      imported++;
    }
  }
  db.prepare("INSERT OR REPLACE INTO extension_metadata (key, value) VALUES ('standing_migrated', ?)")
    .run(new Date().toISOString());
  return imported;
}

/** Same one-instruction-per-line format the retired file used. */
function parseStandingInstructions(raw: string): string[] {
  const seen = new Set<string>();
  const instructions: string[] = [];
  for (const line of raw.split("\n")) {
    const instruction = line.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim();
    if (!instruction || instruction.startsWith("#")) continue;
    const key = instruction.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    instructions.push(instruction);
  }
  return instructions;
}

/**
 * `/memory-pin` — the user-facing view of the always-injected pool (formerly a
 * Markdown file, now the SQLite `important` flag).
 */
export function registerMemoryPinCommand(pi: ExtensionAPI, dbManager: DatabaseManager | null): void {
  const requireDb = (): DatabaseManager => {
    if (!dbManager) throw new Error("Memory is not available (no database).");
    return dbManager;
  };

  pi.registerCommand("memory-pin", {
    description: "Pin a fact into the always-injected memory pool (list / add / remove / clear)",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const sub = raw.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      try {
        const db = requireDb();
        if (!raw) {
          const pool = getImportantMemories(db);
          const lines = pool.length > 0
            ? [
              `📌 ${pool.length} always-injected ${pool.length === 1 ? "entry" : "entries"}:`,
              ...pool.map((entry, index) => {
                const scope = entry.target === "memory" && entry.project ? `project:${entry.project}` : entry.target;
                return `  ${index + 1}. [${scope}] ${entry.content}`;
              }),
              "",
              "Use /memory-pin remove <n> or /memory-pin clear.",
            ]
            : ["📌 Nothing pinned. Use /memory-pin <text> to always inject a fact into every session."];
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (sub === "clear") {
          const pool = getImportantMemories(db);
          for (const entry of pool) removeMemory(db, entry.id);
          ctx.ui.notify(`📌 Cleared ${pool.length} pinned ${pool.length === 1 ? "entry" : "entries"}.`, "info");
          return;
        }
        if (sub === "remove" || sub === "delete") {
          const index = Number(raw.split(/\s+/)[1]);
          const pool = getImportantMemories(db);
          if (!Number.isInteger(index) || index < 1 || index > pool.length) {
            ctx.ui.notify(`📌 Give a number between 1 and ${pool.length}.`, "error");
            return;
          }
          const target = pool[index - 1];
          removeMemory(db, target.id);
          ctx.ui.notify(`📌 Unpinned: ${target.content.slice(0, 80)}`, "info");
          return;
        }

        const text = raw.replace(/^(add|pin)\s+/i, "").trim();
        if (!text) {
          ctx.ui.notify("📌 Nothing to pin.", "error");
          return;
        }
        syncMemoryEntry(db, { content: text, target: "memory", important: true });
        const pool = getImportantMemories(db);
        ctx.ui.notify(`📌 Pinned (${pool.length} total, injected into every session): ${text.slice(0, 80)}`, "info");
      } catch (err) {
        ctx.ui.notify(`📌 Pin failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
