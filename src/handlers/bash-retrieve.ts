/**
 * Optional memory retrieval on bash tool calls.
 *
 * When the model runs a bash command, the command text is reduced to search
 * terms — command names, relative path/file names, and meaningful argument
 * words — and those terms are FTS5-searched against memory. The top-K matches
 * are appended to the tool result, so the model sees them right after the tool
 * output (never in the system prompt, so the LLM prefix cache stays intact).
 *
 * Term extraction follows the project convention: tokens starting with `-`
 * (flags) or `/` (absolute paths and switch-style keys) are dropped, as are
 * shell syntax, env assignments, and shell builtins. What remains is command
 * names and paths — exactly what memory entries tend to talk about.
 *
 * Scope: only the current project's memories plus global (project IS NULL)
 * ones are retrieved. Dedup is **shared with auto-retrieve**: every injected
 * row goes into the same `retrieved_memories` set (at most once per session
 * across both features), so repeated commands like `npm run check` do not
 * re-inject the same facts over and over; `session_compact` / session quit
 * reset the set, after which facts become injectable again.

 * Delivery uses the same custom message as auto-retrieve: the bash output is
 * left untouched, and pi injects a separate custom message (steer queue)
 * right after the tool output, before the model's next continuation. The
 * transcript renders it through the shared renderer as a collapsible block.
 */

import { isBashToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RETRIEVAL_MESSAGE_TYPE,
  renderRetrievalMessage,
  buildRetrievalDetails,
} from "./auto-retrieve.js";
import { searchMemories, type SqliteMemoryEntry } from "../store/sqlite-memory-store.js";
import {
  getRetrievedMemoryIds,
  markRetrievedMemoryIds,
  resetSessionRetrievals,
} from "../store/retrieval-store.js";
import type { DatabaseManager } from "../store/db.js";
import type { AutoRetrieveTarget, MemoryConfig } from "../types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASH_RETRIEVE_KEYWORDS_ONLY,
  DEFAULT_BASH_RETRIEVE_MAX_CHARS,
  DEFAULT_BASH_RETRIEVE_MIN_MATCHED_TERMS,
  DEFAULT_BASH_RETRIEVE_MIN_TERMS,
  DEFAULT_BASH_RETRIEVE_TOP_K,
} from "../constants.js";

const DEFAULT_TARGETS: readonly AutoRetrieveTarget[] = ["memory", "user", "failure"];

/** Cap on extracted terms, so a long command line cannot build a huge query. */
const MAX_EXTRACTED_TERMS = 10;

/** Shell control keywords and builtins that never carry memory intent. */
const NOISE_WORDS = new Set([
  "cd", "echo", "export", "alias", "unalias", "unset", "set", "exit",
  "true", "false", "history", "clear", "pwd", "pushd", "popd", "shopt",
  "umask", "hash", "shift", "times", "logout", "local", "declare", "readonly",
  "enable", "eval", "builtin", "let", "typeset", "fc", "do", "done", "fi",
  "then", "else", "elif", "case", "esac", "function", "select", "until",
  "while", "for", "in", "if",
]);

/** Command modifiers that prefix the real command name (`sudo npm test`). */
const MODIFIER_WORDS = new Set(["sudo", "nohup", "time", "env", "command", "nice", "setsid"]);

/** Tokens made only of shell punctuation/operators (`&&`, `|`, `>`, `)`). */
const PURE_SYNTAX = /^[&|<>;(){}[\]*?!.,=:$%^~+@-]+$/;

/** Trailing file extension, used to derive a searchable stem (foo.ts → foo). */
const FILE_EXTENSION = /\.\w{1,5}$/;

/** Strip quoting/backtick edges shell words can carry. */
function cleanToken(raw: string): string {
  return raw
    .replace(/^['"`]+/, "")
    .replace(/['"`]+$/, "");
}

/** Add the extension-less stem for filename-like terms (`foo.ts` → `foo`). */
function appendStem(term: string): string[] {
  const stem = term.replace(FILE_EXTENSION, "");
  if (stem.length >= 4 && stem !== term) return [term, stem];
  return [term];
}

function isSearchableToken(token: string): boolean {
  if (token.length < 2) return false;
  // Project convention: `-flag` and `/switch`/absolute-path tokens are keys,
  // not search terms — only command names and relative paths are interesting.
  if (token.startsWith("-") || token.startsWith("/")) return false;
  if (token.startsWith("$") || token.startsWith("`")) return false;
  if (token.includes("=")) return false; // env assignment / option value
  if (PURE_SYNTAX.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  // Redirects/env noise like `2>&1` or `123` carry no letters — never terms.
  if (!/\p{L}/u.test(token)) return false;
  const lower = token.toLowerCase();
  return !NOISE_WORDS.has(lower) && !MODIFIER_WORDS.has(lower);
}

/** Expand one searchable token into the terms it should contribute. */
function expandToken(token: string): string[] {
  if (!token.includes("/")) return appendStem(token);
  // Relative path: the basename (file/module name) is what memory references,
  // not the whole path — `src/store/sqlite-memory-store.ts` → `sqlite-memory-store`.
  const base = token.split("/").filter(Boolean).pop();
  return base ? appendStem(base) : [];
}

/**
 * Reduce a bash command to FTS5 search terms. Exported for tests.
 *
 * `ls -la /var/log` → `["ls"]`; `npm run build -- --watch` →
 * `["npm", "run", "build"]`; `rg -n "foo" src/store/db.ts` →
 * `["rg", "foo", "db.ts"]`.
 */
export function extractCommandTerms(command: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const push = (term: string): boolean => {
    const normalized = term.toLowerCase();
    if (normalized.length < 2 || seen.has(normalized)) return false;
    seen.add(normalized);
    terms.push(normalized);
    return terms.length >= MAX_EXTRACTED_TERMS;
  };

  for (const raw of command.split(/\s+/)) {
    const token = cleanToken(raw);
    if (!isSearchableToken(token)) continue;
    for (const term of expandToken(token)) {
      if (push(term)) return terms;
    }
  }
  return terms;
}

function scopeLabel(entry: SqliteMemoryEntry): string {
  if (entry.target === "failure") {
    return entry.category ? `failure:${entry.category}` : "failure";
  }
  if (entry.target === "memory" && entry.project) return `project:${entry.project}`;
  return entry.target;
}

/** The text block appended to the tool result the model sees. */
export function renderBashRetrieveBlock(entries: SqliteMemoryEntry[]): string {
  return [
    "<retrieved-memory>",
    "The following durable memories match the command you just ran:",
    ...entries.map((entry) => {
      const content = entry.content.length > 300 ? `${entry.content.slice(0, 300)}…` : entry.content;
      return `- [${scopeLabel(entry)}] ${content}`;
    }),
    "</retrieved-memory>",
  ].join("\n");
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const manager = ctx?.sessionManager;
  return typeof manager?.getSessionId === "function" ? manager.getSessionId() : undefined;
}

export interface BashRetrieveOptions {
  dbManager: DatabaseManager | null;
  /** Skip retrieval until true (lazy-initialization guard). */
  isReady?: () => boolean;
  /** Binds the active project from the tool cwd (project-scoped search). */
  bindProjectFromCwd?: (cwd?: string) => void | Promise<void>;
  /** Resolves the active project name after binding. */
  resolveProjectName?: () => string;
}

/**
 * Register bash-triggered retrieval. No-ops unless
 * `config.bashRetrieve.enabled` is true (default off), so default
 * installations are completely unchanged.
 */
export function setupBashRetrieve(
  pi: ExtensionAPI,
  config: MemoryConfig,
  options: BashRetrieveOptions,
): void {
  const bashRetrieve = config.bashRetrieve;
  if (!bashRetrieve?.enabled) return;

  const { dbManager, isReady, bindProjectFromCwd, resolveProjectName } = options;
  const topK = Math.max(1, bashRetrieve.topK ?? DEFAULT_BASH_RETRIEVE_TOP_K);
  const maxChars = Math.max(1, bashRetrieve.maxChars ?? DEFAULT_BASH_RETRIEVE_MAX_CHARS);
  const minTerms = Math.max(1, bashRetrieve.minTerms ?? DEFAULT_BASH_RETRIEVE_MIN_TERMS);
  const minMatchedTerms = Math.max(2, bashRetrieve.minMatchedTerms ?? DEFAULT_BASH_RETRIEVE_MIN_MATCHED_TERMS);
  const keywordsOnly = bashRetrieve.keywordsOnly ?? DEFAULT_BASH_RETRIEVE_KEYWORDS_ONLY;
  const targets: readonly AutoRetrieveTarget[] =
    bashRetrieve.targets && bashRetrieve.targets.length > 0 ? bashRetrieve.targets : DEFAULT_TARGETS;

  // Same collapsible transcript block as auto-retrieve (idempotent — also
  // registered here so bashRetrieve works even when autoRetrieve is off).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(RETRIEVAL_MESSAGE_TYPE, renderRetrievalMessage as never);
  }

  const searchTargets = (query: string, projects: Array<string | null>): SqliteMemoryEntry[] => {
    if (!dbManager) return [];
    const collected: SqliteMemoryEntry[] = [];
    const seen = new Set<number>();
    for (const target of targets) {
      for (const entry of searchMemories(dbManager, query, {
        target, projects, limit: topK, requireMatchedTerms: minMatchedTerms, keywordsOnly,
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

  // Fired after the bash tool executed: the bash output is left untouched and
  // the memory block is delivered as a separate custom message (pi's steer
  // queue), which the run loop injects right after the tool output and before
  // the model's next continuation — the model sees it as its own block.
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!isBashToolResult(event)) return;
      if (isReady && !isReady()) return;
      if (!dbManager) return;

      const command = typeof event.input.command === "string" ? event.input.command : "";
      const terms = extractCommandTerms(command);
      if (terms.length < minTerms) return;

      // Current project + global only: other projects' facts are irrelevant.
      await bindProjectFromCwd?.(ctx.cwd);
      const activeProject = (resolveProjectName?.() ?? "").trim();
      const projects: Array<string | null> = activeProject ? [null, activeProject] : [null];

      // Shared per-session dedup with auto-retrieve: a row is injected at most
      // once per session across both features (cleared on compact/quit below).
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const alreadyInjected = getRetrievedMemoryIds(dbManager, sessionId);

      const fresh = searchTargets(terms.join(" "), projects)
        .filter((entry) => !alreadyInjected.has(entry.id))
        // Skip this session's own facts: entries extracted/written by the
        // current session carry its id in source_session and must not be
        // fed back into it (the id-churn-safe provenance filter).
        .filter((entry) => entry.sourceSession !== sessionId);
      const picked = pickWithinBudget(fresh);
      if (picked.length === 0) return;

      markRetrievedMemoryIds(dbManager, sessionId, picked.map((entry) => entry.id));

      pi.sendMessage({
        customType: RETRIEVAL_MESSAGE_TYPE,
        content: renderBashRetrieveBlock(picked),
        display: true,
        details: buildRetrievalDetails(picked, terms),
      });
    } catch {
      // Retrieval must never break the tool result.
      return;
    }
  });

  // After compaction the model has lost the injected context; allow the same
  // facts to be injected once more (idempotent with auto-retrieve's reset).
  pi.on("session_compact", (_event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId || !dbManager) return;
    try { resetSessionRetrievals(dbManager, sessionId); } catch { /* best effort */ }
  });

  // Quit does NOT clear dedup: same rationale as auto-retrieve — a resumed
  // session reuses the session id, so the rows survive pi restarts, and only
  // compaction resets them.
}
