/**
 * Optional FTS5 auto-retrieval (Task 1): before each user message, cheaply
 * search memories and append the top-K matches directly after the user text —
 * NOT in the system prompt — so Pi's LLM prefix cache stays intact.
 *
 * Semantics:
 * - Every memory row is injected **at most once per session** (persisted in
 *   `retrieved_memories`, indexed by session id, surviving restarts/resumes).
 * - After context compaction the model has effectively forgotten the injected
 *   facts, so `session_compact` clears the session's dedup and injection can
 *   run once more. On a real session quit the rows are dropped too.
 * - An interactive widget (collapsed: entry count + a few keywords; ctrl+o
 *   toggles to the full block) shows the user what was injected.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchMemories, type SqliteMemoryEntry } from "../store/sqlite-memory-store.js";
import {
  getRetrievedMemoryIds,
  markRetrievedMemoryIds,
  pruneRetrievalRows,
  resetSessionRetrievals,
} from "../store/retrieval-store.js";
import type { DatabaseManager } from "../store/db.js";
import type { AutoRetrieveTarget, MemoryConfig } from "../types.js";
import {
  DEFAULT_AUTO_RETRIEVE_MAX_CHARS,
  DEFAULT_AUTO_RETRIEVE_MIN_QUERY_CHARS,
  DEFAULT_AUTO_RETRIEVE_TOP_K,
} from "../constants.js";

const RETRIEVAL_WIDGET_KEY = "memory-retrieve";
const RETRIEVAL_WIDGET_HINT = "ctrl+o";
const DEFAULT_TARGETS: readonly AutoRetrieveTarget[] = ["memory", "user", "failure"];
const RETRIEVAL_PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
interface LastInjection {
  collapsed: string[];
  expanded: string[];
}

export interface AutoRetrieveOptions {
  dbManager: DatabaseManager | null;
  /** Skip retrieval until true (lazy-initialization guard). */
  isReady?: () => boolean;
}

/** Purge stale dedup rows (sessions that crashed without shutdown). */
export function pruneAutoRetrievalRows(dbManager: DatabaseManager): void {
  try { pruneRetrievalRows(dbManager, RETRIEVAL_PRUNE_MAX_AGE_MS); } catch { /* best effort */ }
}

/** System-style prompts sent by background subprocess sessions (reviews,
 * flush/compaction, correction) must never trigger retrieval. */
function isBackgroundPrompt(text: string): boolean {
  return text.startsWith("Review the conversation above")
    || text.startsWith("[System: The session is being compressed")
    || text.startsWith("[System: Save anything worth")
    || (text.length > 300 && (text.includes("--- Current Memory ---")
      || text.includes("--- Conversation to Review ---")));
}

function scopeLabel(entry: { target: AutoRetrieveTarget; project: string | null; category: string | null }): string {
  if (entry.target === "failure") {
    return entry.category ? `failure:${entry.category}` : "failure";
  }
  if (entry.target === "memory" && entry.project) return "project";
  return entry.target;
}

function formatLine(entry: SqliteMemoryEntry): string {
  const content = entry.content.length > 300 ? `${entry.content.slice(0, 300)}…` : entry.content;
  return `- [${scopeLabel(entry)}] ${content}`;
}

function keywordPreview(entries: SqliteMemoryEntry[]): string {
  const words: string[] = [];
  for (const entry of entries) {
    for (const keyword of entry.keywords ?? []) {
      if (words.length >= 6) break;
      if (!words.includes(keyword.toLowerCase())) words.push(keyword);
    }
    if (words.length >= 6) break;
  }
  if (words.length === 0) {
    for (const entry of entries) {
      for (const word of entry.content.split(/\s+/).slice(0, 2)) {
        if (words.length >= 4) break;
        const clean = word.replace(/^[^A-Za-zА-Яа-я0-9]+|[^A-Za-zА-Яа-я0-9]+$/g, "");
        if (clean && !words.includes(clean.toLowerCase())) words.push(clean);
      }
    }
  }
  return words.join(", ") || "(no keywords)";
}

function renderRetrievalBlock(entries: SqliteMemoryEntry[]): string {
  const lines = [
    "<retrieved-memory>",
    "The following durable memories match your message:",
    ...entries.map(formatLine),
    "</retrieved-memory>",
  ];
  return lines.join("\n");
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?(): string } }): string | undefined {
  const manager = ctx?.sessionManager;
  return typeof manager?.getSessionId === "function" ? manager.getSessionId() : undefined;
}

/**
 * Register auto-retrieval. No-ops unless `config.autoRetrieve.enabled` is
 * true (default off), so default installations are completely unchanged.
 */
export function setupAutoRetrieve(
  pi: ExtensionAPI,
  config: MemoryConfig,
  options: AutoRetrieveOptions,
): void {
  const autoRetrieve = config.autoRetrieve;
  if (!autoRetrieve?.enabled) return;

  const { dbManager, isReady } = options;
  const topK = Math.max(1, autoRetrieve.topK ?? DEFAULT_AUTO_RETRIEVE_TOP_K);
  const maxChars = Math.max(1, autoRetrieve.maxChars ?? DEFAULT_AUTO_RETRIEVE_MAX_CHARS);
  const minQueryChars = Math.max(1, autoRetrieve.minQueryChars ?? DEFAULT_AUTO_RETRIEVE_MIN_QUERY_CHARS);
  const targets: readonly AutoRetrieveTarget[] =
    autoRetrieve.targets && autoRetrieve.targets.length > 0 ? autoRetrieve.targets : DEFAULT_TARGETS;

  // UI state per session (transient — only the dedup rows persist).
  const lastInjection = new Map<string, LastInjection>();
  const expandedSessions = new Set<string>();

  const clearWidget = (ctx: { ui?: unknown }): void => {
    try {
      (ctx.ui as { setWidget?: (key: string, content: string[] | undefined) => void })
        ?.setWidget?.(RETRIEVAL_WIDGET_KEY, undefined);
    } catch { /* best effort */ }
  };

  const searchTargets = (query: string): SqliteMemoryEntry[] => {
    if (!dbManager) return [];
    const collected: SqliteMemoryEntry[] = [];
    const seen = new Set<number>();
    for (const target of targets) {
      for (const entry of searchMemories(dbManager, query, { target, limit: topK })) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        collected.push(entry);
        if (collected.length >= topK) return collected;
      }
    }
    return collected;
  };

  const pickWithinBudget = (entries: SqliteMemoryEntry[]): SqliteMemoryEntry[] => {
    const picked: SqliteMemoryEntry[] = [];
    let chars = 0;
    for (const entry of entries) {
      const pushChars = formatLine(entry).length;
      if (picked.length > 0 && chars + pushChars > maxChars) break;
      picked.push(entry);
      chars += pushChars;
      if (chars >= maxChars) break;
    }
    return picked;
  };

  pi.on("input", async (event, ctx) => {
    try {
      if (isReady && !isReady()) return;
      const text = typeof event.text === "string" ? event.text : "";
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith("/")) return;
      if (trimmed.length < minQueryChars) return;
      if (isBackgroundPrompt(trimmed)) return;
      const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
      if (!sessionId || !dbManager) return;

      const alreadyInjected = getRetrievedMemoryIds(dbManager, sessionId);
      const fresh = searchTargets(trimmed).filter((entry) => !alreadyInjected.has(entry.id));
      const picked = pickWithinBudget(fresh);
      if (picked.length === 0) return;

      const block = renderRetrievalBlock(picked);
      markRetrievedMemoryIds(dbManager, sessionId, picked.map((entry) => entry.id));

      const noun = picked.length === 1 ? "entry" : "entries";
      const collapsed = [
        `🧠 Retrieved ${picked.length} memory ${noun}: ${keywordPreview(picked)}`,
        `   ${RETRIEVAL_WIDGET_HINT} to expand`,
      ];
      const expanded = [
        `🧠 Retrieved ${picked.length} memory ${noun} (${RETRIEVAL_WIDGET_HINT} to collapse):`,
        "",
        ...picked.map(formatLine),
      ];
      lastInjection.set(sessionId, { collapsed, expanded });
      expandedSessions.delete(sessionId);
      try {
        (ctx.ui as { setWidget?: (key: string, content: string[] | undefined) => void })
          ?.setWidget?.(RETRIEVAL_WIDGET_KEY, collapsed);
      } catch { /* best effort */ }

      return { action: "transform", text: `${text}\n\n${block}`, images: event.images };
    } catch {
      // Retrieval must never break the user's prompt; on any error send it
      // through unchanged.
      return undefined;
    }
  });

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("ctrl+o", {
      description: "Toggle the auto-retrieved memory panel",
      handler: (ctx) => {
        const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
        if (!sessionId) return;
        const entry = lastInjection.get(sessionId);
        if (!entry) return;
        const expanded = !expandedSessions.has(sessionId);
        if (expanded) expandedSessions.add(sessionId);
        else expandedSessions.delete(sessionId);
        try {
          (ctx.ui as { setWidget?: (key: string, content: string[] | undefined) => void })
            ?.setWidget?.(RETRIEVAL_WIDGET_KEY, expanded ? entry.expanded : entry.collapsed);
        } catch { /* best effort */ }
      },
    });
  }

  // After compaction the model has lost the injected context; allow the same
  // facts to be injected once more.
  pi.on("session_compact", (_event, ctx) => {
    const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
    if (!sessionId || !dbManager) return;
    try { resetSessionRetrievals(dbManager, sessionId); } catch { /* best effort */ }
    lastInjection.delete(sessionId);
    expandedSessions.delete(sessionId);
    clearWidget(ctx as { ui?: unknown });
  });

  pi.on("session_shutdown", (event, ctx) => {
    const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
    if (!sessionId || !dbManager) return;
    lastInjection.delete(sessionId);
    expandedSessions.delete(sessionId);
    clearWidget(ctx as { ui?: unknown });
    // Real session end: drop its dedup rows. reload/new/resume/fork keep them
    // so a resumed session continues the "once per session" guarantee.
    if ((event as { reason?: string }).reason === "quit") {
      try { resetSessionRetrievals(dbManager, sessionId); } catch { /* best effort */ }
    }
  });
}