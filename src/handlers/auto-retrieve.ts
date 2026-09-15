/**
 * Optional FTS5 auto-retrieval (Task 1).
 *
 * Before each user message a cheap FTS5 search runs against the message text,
 * and the top-K matches are delivered to the model as a **custom message**
 * appended to the conversation (converted to a user-role text block by Pi).
 * The user's own message is never modified, so the injection is not glued
 * into the bubble they typed.
 *
 * The same custom message is rendered in the transcript by our
 * `registerMessageRenderer` component: collapsed by default it shows only the
 * entry count plus a few keywords, and the standard `app.tools.expand`
 * (default `ctrl+o`) toggle expands it to the full block — the same
 * collapsed/expanded behavior tool output (e.g. quick-edit diffs) uses.
 *
 * Scope: only the current project's memories plus global (project IS NULL)
 * ones are retrieved — other projects' facts are never injected.
 *
 * Semantics:
 * - Every memory row is injected **at most once per session** (persisted in
 *   `retrieved_memories`, indexed by session id, surviving restarts/resumes).
 * - After context compaction the model has effectively forgotten the injected
 *   facts, so `session_compact` clears the session's dedup and injection can
 *   run once more. On a real session quit the rows are dropped too.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { CollapsibleBlockComponent, expandHint } from "./collapsible-block.js";
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
  DEFAULT_AUTO_RETRIEVE_MIN_MATCHED_TERMS,
  DEFAULT_AUTO_RETRIEVE_MIN_QUERY_CHARS,
  DEFAULT_AUTO_RETRIEVE_TOP_K,
} from "../constants.js";
import { collectNaturalLanguageTerms } from "../store/fts-query.js";

export const RETRIEVAL_MESSAGE_TYPE = "memory-retrieval";

const RETRIEVAL_FALLBACK_HINT = "ctrl+o";
const DEFAULT_TARGETS: readonly AutoRetrieveTarget[] = ["memory", "user", "failure"];
const RETRIEVAL_PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Entry shown to the user in the expandable block (serializable into details). */
export interface RetrievalEntryView {
  target: AutoRetrieveTarget;
  project: string | null;
  category: string | null;
  content: string;
  /** Query terms this entry matched (used to bold them in the renderer). */
  matchedTerms?: string[];
}

export interface RetrievalDetails {
  count: number;
  keywords: string;
  /** Significant query terms the match was based on (shown in the collapsed header). */
  triggers?: string[];
  entries: RetrievalEntryView[];
}

/**
 * Highlight the query terms a memory entry matched, wrapping each occurrence
 * with `mark`. Pure helper so the renderer can bold them (theme.bold).
 * Longest matching term wins on overlaps; matching is case-insensitive.
 */
export function highlightMatchedTerms(
  content: string,
  terms: string[],
  mark: (text: string) => string,
): string {
  if (content.length === 0 || terms.length === 0) return content;
  const lower = content.toLowerCase();
  const lowerTerms = terms.map((term) => term.toLowerCase()).filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
  let out = "";
  for (let i = 0; i < lower.length;) {
    let hit: string | null = null;
    for (const term of lowerTerms) {
      if (lower.startsWith(term, i)) { hit = term; break; }
    }
    if (hit) {
      out += mark(content.slice(i, i + hit.length));
      i += hit.length;
    } else {
      out += content[i];
      i += 1;
    }
  }
  return out;
}

/** Shared by auto-retrieve and bash-retrieve for the same transcript renderer. */
export function buildRetrievalDetails(
  entries: SqliteMemoryEntry[],
  fallbackTriggers: string[] = [],
): RetrievalDetails {
  // "in:" must list the terms that actually matched — the same ones the
  // renderer bolds below — so it is derived from the entries' matchedTerms.
  // The caller's query terms are only a fallback (ungated searches).
  const matched = new Set<string>();
  for (const entry of entries) {
    for (const term of entry.matchedTerms ?? []) {
      const normalized = term.trim();
      if (normalized.length > 0) matched.add(normalized);
    }
  }
  const triggers = matched.size > 0 ? [...matched] : fallbackTriggers;
  return {
    count: entries.length,
    keywords: keywordPreview(entries),
    triggers: triggers.slice(0, 6),
    entries: entries.map((entry) => ({
      target: entry.target,
      project: entry.project,
      category: entry.category,
      content: entry.content.length > 500 ? `${entry.content.slice(0, 500)}…` : entry.content,
      matchedTerms: entry.matchedTerms?.slice() ?? [],
    })),
  };
}

export interface AutoRetrieveOptions {
  dbManager: DatabaseManager | null;
  /** Skip retrieval until true (lazy-initialization guard). */
  isReady?: () => boolean;
  /** Binds the active project from the prompt cwd (project-scoped search). */
  bindProjectFromCwd?: (cwd?: string) => void | Promise<void>;
  /** Resolves the active project name after binding. */
  resolveProjectName?: () => string;
}

/** Purge stale dedup rows (sessions that crashed without shutdown). */
export function pruneAutoRetrievalRows(dbManager: DatabaseManager): void {
  try { pruneRetrievalRows(dbManager, RETRIEVAL_PRUNE_MAX_AGE_MS); } catch { /* best effort */ }
}

function scopeLabel(entry: RetrievalEntryView): string {
  if (entry.target === "failure") {
    return entry.category ? `failure:${entry.category}` : "failure";
  }
  if (entry.target === "memory" && entry.project) return `project:${entry.project}`;
  return entry.target;
}

function formatLine(entry: RetrievalEntryView): string {
  return `- [${scopeLabel(entry)}] ${entry.content}`;
}

/** Keywords shown in the collapsed header — falls back to leading words. */
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
  return words.join(", ");
}

/** The text block the model receives (custom message content). */
function renderRetrievalBlock(entries: SqliteMemoryEntry[]): string {
  return [
    "<retrieved-memory>",
    "The following durable memories match your message:",
    ...entries.map((entry) => formatLine({
      target: entry.target,
      project: entry.project,
      category: entry.category,
      content: entry.content.length > 300 ? `${entry.content.slice(0, 300)}…` : entry.content,
    })),
    "</retrieved-memory>",
  ].join("\n");
}

/** Interactive transcript renderer: collapsed count+keywords, expandable. */
export function renderRetrievalMessage(
  message: { details?: unknown },
  options: { expanded: boolean },
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
): Component {
  const details = message.details as RetrievalDetails | undefined;
  const entries = Array.isArray(details?.entries) ? details!.entries : [];
  const count = entries.length;
  const label = `${count} ${count === 1 ? "entry" : "entries"}`;
  const header = theme.fg("accent", `🧠 Retrieved ${label}`)
    + (details?.keywords ? theme.fg("muted", `: ${details.keywords}`) : "")
    + (details?.triggers && details.triggers.length > 0
      ? theme.fg("muted", ` · in: ${details.triggers.join(", ")}`)
      : "");

  return new CollapsibleBlockComponent(
    () => ({
      collapsed: [header, theme.fg("muted", `   ${expandHint()} to expand (or click)`),],
      expanded: [
        header,
        "",
        ...entries.map((entry) => `${theme.fg("muted", `- [${scopeLabel(entry)}] `)}${highlightMatchedTerms(entry.content, entry.matchedTerms ?? [], (s) => theme.bold(s))}`),
      ],
    }),
    options.expanded,
  );
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

  const { dbManager, isReady, bindProjectFromCwd, resolveProjectName } = options;
  const topK = Math.max(1, autoRetrieve.topK ?? DEFAULT_AUTO_RETRIEVE_TOP_K);
  const maxChars = Math.max(1, autoRetrieve.maxChars ?? DEFAULT_AUTO_RETRIEVE_MAX_CHARS);
  const minQueryChars = Math.max(1, autoRetrieve.minQueryChars ?? DEFAULT_AUTO_RETRIEVE_MIN_QUERY_CHARS);
  const minMatchedTerms = Math.max(2, autoRetrieve.minMatchedTerms ?? DEFAULT_AUTO_RETRIEVE_MIN_MATCHED_TERMS);
  const targets: readonly AutoRetrieveTarget[] =
    autoRetrieve.targets && autoRetrieve.targets.length > 0 ? autoRetrieve.targets : DEFAULT_TARGETS;

  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(RETRIEVAL_MESSAGE_TYPE, renderRetrievalMessage as never);
  }

  const searchTargets = (query: string, projects: Array<string | null>): SqliteMemoryEntry[] => {
    if (!dbManager) return [];
    const collected: SqliteMemoryEntry[] = [];
    const seen = new Set<number>();
    for (const target of targets) {
      for (const entry of searchMemories(dbManager, query, {
        target, projects, limit: topK, requireMatchedTerms: minMatchedTerms,
      })) {
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
      const pushChars = entry.content.length + 40;
      if (picked.length > 0 && chars + pushChars > maxChars) break;
      picked.push(entry);
      chars += pushChars;
      if (chars >= maxChars) break;
    }
    return picked;
  };

  // Injected via before_agent_start: Pi appends the returned custom message
  // to THIS turn's context right after the user message (the user's own text
  // is never modified), and our renderer draws it collapsed in the transcript.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      if (isReady && !isReady()) return;
      const prompt = typeof (event as { prompt?: string }).prompt === "string"
        ? (event as { prompt: string }).prompt
        : "";
      const trimmed = prompt.trim();
      if (!trimmed || trimmed.startsWith("/")) return;
      if (trimmed.length < minQueryChars) return;
      if (isBackgroundPrompt(trimmed)) return;
      const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
      if (!sessionId || !dbManager) return;

      // Current project + global only: other projects' facts are irrelevant here.
      await bindProjectFromCwd?.((ctx as { cwd?: string }).cwd);
      const activeProject = (resolveProjectName?.() ?? "").trim();
      const projects: Array<string | null> = activeProject ? [null, activeProject] : [null];

      const alreadyInjected = getRetrievedMemoryIds(dbManager, sessionId);
      const fresh = searchTargets(trimmed, projects).filter((entry) => !alreadyInjected.has(entry.id));
      const picked = pickWithinBudget(fresh);
      if (picked.length === 0) return;

      markRetrievedMemoryIds(dbManager, sessionId, picked.map((entry) => entry.id));

      return {
        message: {
          customType: RETRIEVAL_MESSAGE_TYPE,
          content: renderRetrievalBlock(picked),
          display: true,
          details: buildRetrievalDetails(picked, collectNaturalLanguageTerms(trimmed)),
        },
      };
    } catch {
      // Retrieval must never break the user's prompt.
      return;
    }
  });

  // After compaction the model has lost the injected context; allow the same
  // facts to be injected once more.
  pi.on("session_compact", (_event, ctx) => {
    const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
    if (!sessionId || !dbManager) return;
    try { resetSessionRetrievals(dbManager, sessionId); } catch { /* best effort */ }
  });

  pi.on("session_shutdown", (event, ctx) => {
    const sessionId = sessionIdOf(ctx as { sessionManager?: { getSessionId?(): string } });
    if (!sessionId || !dbManager) return;
    // Real session end: drop its dedup rows. reload/new/resume/fork keep them
    // so a resumed session continues the "once per session" guarantee.
    if ((event as { reason?: string }).reason === "quit") {
      try { resetSessionRetrievals(dbManager, sessionId); } catch { /* best effort */ }
    }
  });
}