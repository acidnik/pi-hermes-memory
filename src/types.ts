/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";

export type SessionSearchVariant = "legacy" | "anchors";

export type ThinkingLevel = ModelThinkingLevel;

export type ReviewTransport = "direct" | "subprocess";

export interface SessionSearchConfig {
  /** Session search implementation variant. Default: legacy */
  variant: SessionSearchVariant;
}

export type AutoRetrieveTarget = "memory" | "user" | "failure";

/**
 * Optional FTS5 auto-retrieval: before each user message, cheaply search
 * memories and append the top-K matches after the user text (not in the
 * system prompt) so the LLM prefix cache stays intact. Each memory entry is
 * injected at most once per session (persisted in `retrieved_memories`),
 * reset after context compaction and on session quit.
 */
export interface AutoRetrieveConfig {
  /** Enables the behavior. Default: false (off) */
  enabled?: boolean;
  /** Maximum number of memories appended per message. Default: 3 */
  topK?: number;
  /** Maximum total characters of the appended block. Default: 1500 */
  maxChars?: number;
  /** Which targets to search. Default: all (memory, user, failure) */
  targets?: AutoRetrieveTarget[];
  /** Minimum query length before retrieval runs. Default: 12 */
  minQueryChars?: number;
  /**
   * Minimum distinct query terms a memory must match to be injected. When > 1
   * the search is a single OR query (BM25 ranked) gated by this count — no
   * AND stage and no recency fallback, so weakly related memories stay out.
   * Default: 2
   */
  minMatchedTerms?: number;
  /**
   * Match ONLY against the curated keywords column (not full content).
   * Default: true — much higher precision, but entries without keywords are
   * not found.
   */
  keywordsOnly?: boolean;
}

/**
 * Optional memory retrieval on bash tool calls: the model's bash command is
 * reduced to search terms (command names, relative paths, filenames — flags
 * and absolute paths are dropped), FTS5-searched against memory, and the
 * top-K matches are appended to the tool result as a block the model sees
 * right after the tool output. Off by default.
 */
export interface BashRetrieveConfig {
  /** Enables the behavior. Default: false (off) */
  enabled?: boolean;
  /** Maximum number of memories appended per tool result. Default: 4 */
  topK?: number;
  /** Maximum total characters of the appended block. Default: 1500 */
  maxChars?: number;
  /** Which targets to search. Default: all (memory, user, failure) */
  targets?: AutoRetrieveTarget[];
  /** Minimum meaningful terms in the command before searching. Default: 1 */
  minTerms?: number;
  /**
   * Minimum distinct query terms a memory must match to be injected. When > 1
   * the search is a single OR query (BM25 ranked) gated by this count — no
   * AND stage and no recency fallback, so weakly related memories stay out.
   * Default: 2
   */
  minMatchedTerms?: number;
  /**
   * Match ONLY against the curated keywords column (not full content).
   * Default: true — much higher precision, but entries without keywords are
   * not found.
   */
  keywordsOnly?: boolean;
}

export interface MemoryConfig {
  /** Defer policy-only memory initialization until first use. Default: false */
  lazyInitialization?: boolean;
  /**
   * RETIRED — not parsed from the config file. Memory is SQLite-only: the
   * Markdown file layer is unreachable, so any value other than `policy-only`
   * is ignored. Kept as a type for the (test-only) legacy file path.
   */
  memoryMode: "policy-only" | "legacy-inject";
  /** Policy prompt style used when memoryMode is policy-only. Default: full */
  memoryPolicyStyle?: "full" | "compact" | "custom" | "none";
  /** Custom policy prompt text used when memoryPolicyStyle is custom */
  memoryPolicyCustomText?: string;
  /** RETIRED — legacy Markdown budget, no longer enforced or configurable. */
  memoryCharLimit: number;
  /** RETIRED — Markdown files are never written. Not parsed from config. */
  markdownMirror?: boolean;
  /** RETIRED — legacy Markdown budget, no longer enforced or configurable. */
  userCharLimit: number;
  /** RETIRED — legacy Markdown budget, no longer enforced or configurable. */
  projectCharLimit: number;
  /** Turns between background auto-reviews. Default: 10 */
  nudgeInterval: number;
  /** Recent conversation messages included in background review. 0 = all. Default: 0 */
  reviewRecentMessages?: number;
  /**
   * Review only the conversation portion not yet seen by a previous
   * auto-review of this session (delta since the last run) instead of the
   * whole branch every time. Default: true — saves tokens; the prompt marks
   * the fragment and the current-memory section guards duplicates.
   */
  reviewDeltaOnly?: boolean;
  /** Enable background learning loop. Default: true */
  reviewEnabled: boolean;
  /** How background review invokes the LLM. Default: direct */
  reviewTransport?: ReviewTransport;
  /** Flush memories before compaction. Default: true */
  flushOnCompact: boolean;
  /** Flush memories on session shutdown. Default: true */
  flushOnShutdown: boolean;
  /** Minimum user turns before flush triggers. Default: 6 */
  flushMinTurns: number;
  /** Recent conversation messages included in session flush. 0 = all. Default: 0 */
  flushRecentMessages?: number;
  /** Override extension storage directory. Default: ~/.pi/agent/pi-hermes-memory */
  memoryDir?: string;
  /** Directory for project-scoped memory (relative to ~/.pi/agent). Default: "projects-memory" */
  projectsMemoryDir?: string;
  /** Session search configuration. Default: { variant: "legacy" } */
  sessionSearch?: SessionSearchConfig;
  /** Auto-retrieval of memories before user messages. Default: disabled */
  autoRetrieve?: AutoRetrieveConfig;
  /** Memory retrieval on bash tool calls. Default: disabled */
  bashRetrieve?: BashRetrieveConfig;
  /** Run a full SQLite quick_check asynchronously after opening. Default: true */
  quickCheckOnOpen?: boolean;
  /** Override model used for child pi -p subprocess LLM calls. Default: unset */
  llmModelOverride?: string;
  /** Fallback model chain tried in order when the primary review model fails (rate limit, 401/403, 404, 500/503, invalid response). Default: unset */
  llmFallbackModels?: string[];
  /** Override thinking level used for child pi -p subprocess LLM calls. Default: unset */
  llmThinkingOverride?: ThinkingLevel;
  /** Trusted Pi extension sources required by child processes, such as custom providers or auth adapters. */
  childExtensionPaths?: string[];
  /** RETIRED — memory has no size budget. Not parsed from config. */
  memoryOverflowStrategy?: MemoryOverflowStrategy;
  /** RETIRED — memory has no size budget. Not parsed from config. */
  overflowGraceMs?: number;
  /** RETIRED — auto-consolidation on overflow is gone (no budget to overflow). */
  autoConsolidate: boolean;
  /** Detect user corrections and trigger immediate memory save. Default: true */
  correctionDetection: boolean;
  /** Override strong correction regex sources. Missing = defaults; [] = none. */
  correctionStrongPatterns?: string[];
  /** Override weak correction regex sources. Missing = defaults; [] = none. */
  correctionWeakPatterns?: string[];
  /** Override negative correction regex sources. Missing = defaults; [] = none. */
  correctionNegativePatterns?: string[];
  /** Override directive words used after weak correction patterns. Missing = defaults; [] = none. */
  correctionDirectiveWords?: string[];
  /** Inject recent failure memories into the system prompt. Default: true */
  failureInjectionEnabled: boolean;
  /** Maximum age in days for injected failure memories. Default: 7 */
  failureInjectionMaxAgeDays: number;
  /** Maximum number of failure memories to inject. Default: 5 */
  failureInjectionMaxEntries: number;
  /** Tool calls before triggering background review (in addition to turn count). Default: 15 */
  nudgeToolCalls: number;
  /** Maximum time in milliseconds for a consolidation run, auto or manual. Default: 180000 */
  consolidationTimeoutMs: number;
  /** Log failed auto-consolidation attempts to the session console. Default: true */
  autoConsolidationWarnOnFailure: boolean;
  /** Inject pinned STANDING.md instructions into every session. Default: true */
  standingInstructionsEnabled: boolean;
  /**
   * Session retention window in days. A positive value opts in to pruning
   * sessions (and their messages) older than the window on startup; `0`/omitted
   * disables pruning so no existing searchable history is silently deleted.
   * Default: 0 (disabled).
   */
  sessionRetentionDays?: number;
}

export type MemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  warning?: string;
  warnings?: string[];
  target?: "memory" | "user" | "failure" | "project";
  entries?: string[];
  entry_count?: number;
  evicted_entries?: string[];
  evicted_count?: number;
  matches?: string[];
  /**
   * Display-only fields for the tool renderer. They are STRIPPED from the
   * model-facing tool payload (see MEMORY_TOOL_DISPLAY_FIELDS in
   * tools/memory-tool.ts) so the transcript can show what was written without
   * paying tokens for text the model already sent.
   */
  /** Entry text that was added / now stored / replaced (the new text). */
  entry?: string;
  /** Full text of the entry that a replace replaced. */
  previous_entry?: string;
  /** Full text of the entry that a remove deleted. */
  removed_entry?: string;
  /** Searchable keywords carried by the affected entry. */
  keywords?: string[];
  /** Active project name for project-scoped writes. */
  project?: string;
  /** Targets that contain old_text when a replace/remove was sent to the wrong one. */
  matching_targets?: Array<"memory" | "user" | "failure" | "project">;
}

export interface MemoryMutationOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
  category?: MemoryCategory;
  failureReason?: string;
  project?: string;
  /** Search synonyms / equivalents / inflections (add operations only). */
  keywords?: string[];
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}

export interface ConsolidationResult {
  /** Whether consolidation succeeded */
  consolidated: boolean;
  /** Error message if consolidation failed */
  error?: string;
  /**
   * Set when another session already holds the consolidation lock for this
   * target. Nothing is broken — the work is happening elsewhere — so callers
   * should tell the user to retry rather than report a failed consolidation.
   */
  deferred?: boolean;
}

export type SkillScope = "global" | "project";

export interface SkillIndex {
  /** Stable id for read/update/delete operations */
  skillId: string;
  /** Whether the skill is global or project-scoped */
  scope: SkillScope;
  /** File name on disk (usually SKILL.md) */
  fileName: string;
  /** Absolute path to the skill file */
  path: string;
  /** Active project name for project-scoped skills */
  projectName?: string;
  /** Pi skill slug stored in frontmatter and folder name */
  name: string;
  /** Optional human-friendly title preserved for UI output */
  displayName?: string;
  /** Short description shown in skill listings */
  description: string;
  /** ISO date created */
  created: string;
  /** ISO date last updated */
  updated: string;
}

export interface SkillDocument extends SkillIndex {
  /** Full markdown body (after frontmatter) */
  body: string;
  /** Version number */
  version: number;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
  skillId?: string;
  scope?: SkillScope;
  path?: string;
  conflictType?: "duplicate" | "similar" | "name-collision" | "scope-conflict";
  similarSkillIds?: string[];
  suggestedAction?: "patch" | "update" | "rename";
}

/**
 * Extract displayable text from a Pi session entry message.
 *
 * Accepts any value — returns null for non-message entries (BashExecutionMessage,
 * NotificationMessage, etc.) that lack a `content` property.
 *
 * Returns the concatenated text, truncated to `maxLength` chars.
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, content } = msg as Record<string, unknown>;
  if (typeof role !== "string") return null;

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const text = (content as TextContent[])
      .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text.length > 0 ? text.slice(0, maxLength) : null;
  }
  return null;
}
