/**
 * Write-time scope lint for memory writes.
 *
 * A durable fact phrased as an instruction can still be project-scoped ("when I
 * say deploy, publish npm package X from repo Y"). The target descriptions
 * overlap for exactly those facts, so a wrong-target write is easy — and was
 * observed live (a per-repo release contract saved to the user profile). This
 * module detects project-specific signals in text headed for the user profile
 * and returns a NON-BLOCKING hint: the write still happens, the caller just
 * learns that the scope looks wrong.
 */

export interface ScopeHint {
  /** Snippets that made the content look project-specific. */
  matched: string[];
}

/** Snippets are shortened before they are echoed back to the model. */
const MAX_SNIPPET_LENGTH = 48;
const MAX_MATCHES = 4;

interface Signal {
  pattern: RegExp;
}

/**
 * One of these is enough to warn: the content names something that cannot be
 * true outside one repository, package or machine checkout.
 */
const STRONG_SIGNALS: Signal[] = [
  // Absolute paths (~/..., /home/..., /opt/...) — tied to one checkout/machine.
  { pattern: /(?:^|[\s(`'"])(?:~|\/home|\/Users|\/root|\/opt|\/usr|\/etc|\/var|\/srv)\/[^\s`"'()[\]]+/ },
  // Git remotes and forge URLs.
  { pattern: /(?:github\.com|gitlab\.com|bitbucket\.org)[:/][^\s`"')]+/i },
  { pattern: /git@[a-z0-9.-]+:[^\s`"')]+/i },
  // Scoped npm/registry package names (@scope/name).
  { pattern: /@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/i },
  // Backticked commands that act on a specific package, repo or checkout.
  { pattern: /`[^`\n]*\b(?:npm|pnpm|yarn|bun|cargo|poetry|uv|pip|just|make|docker|podman|git|pi)\s+[a-z][a-z-]*[^`\n]*`/i },
];

/**
 * Two of these are needed: each can legally appear in a genuine cross-project
 * preference (someone can prefer TypeScript, or prefer `npm run test`).
 */
const WEAK_SIGNALS: Signal[] = [
  // Repository-relative paths.
  { pattern: /(?:^|[\s(`'"])(?:src|app|apps|packages|services|scripts|tests?|docs|infra|migrations|db|api|web|frontend|backend)\/[A-Za-z0-9._/-]+/ },
  // Manifest / config filenames.
  { pattern: /\b(?:package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|docker-compose(?:\.[a-z]+)?|justfile|Makefile|\.env(?:\.[a-z0-9._-]+)?)\b/i },
  // Package-manager script invocations.
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run|test|build|dev|lint|deploy)\b/i },
  // "this repo" style binders.
  { pattern: /\b(?:this|our|the)\s+(?:repo|repository|codebase|project|app)\b/i },
];

function shorten(snippet: string): string {
  // Signals may capture a preceding space or bracket for word boundaries, and
  // backticked commands carry their delimiters.
  const trimmed = snippet.trim().replace(/^[\s(`'"]+/, "").replace(/[\s`'"]+$/, "");
  return trimmed.length > MAX_SNIPPET_LENGTH ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH - 1)}…` : trimmed;
}

function collect(signals: Signal[], content: string, seen: Set<string>): string[] {
  const found: string[] = [];
  for (const signal of signals) {
    const match = content.match(signal.pattern);
    if (!match) continue;
    const snippet = shorten(match[0]);
    const key = snippet.toLowerCase();
    if (!snippet || seen.has(key)) continue;
    seen.add(key);
    found.push(snippet);
  }
  return found;
}

/**
 * Returns a hint when `content` looks like it belongs to the current project
 * rather than to the user profile, or null when nothing project-specific (or
 * only one ambiguous signal) is present.
 */
export function detectProjectScopeSignals(content: string): ScopeHint | null {
  if (!content.trim()) return null;
  const seen = new Set<string>();
  const strong = collect(STRONG_SIGNALS, content, seen);
  const weak = collect(WEAK_SIGNALS, content, seen);
  if (strong.length === 0 && weak.length < 2) return null;
  return { matched: [...strong, ...weak].slice(0, MAX_MATCHES) };
}

/**
 * Non-blocking warning for a durable entry saved without keywords. Automatic
 * retrieval (before user messages and on bash tool calls) matches the keywords
 * column only, so a keyword-less entry is invisible to it — memory_search still
 * finds it by content.
 */
export function buildMissingKeywordsWarning(target: string): string {
  return [
    `No keywords: automatic retrieval will never surface this ${target} entry — it matches keywords only.`,
    `memory_search still finds it by content. Add 3-8 keywords that should pull this entry when they appear in a user prompt or a bash command — the specific terms the user or the agent would use for this fact (synonyms, other languages, inflections, file/command/package/tool names); generic words are noise.`,
    `Saved as requested — add them with memory_replace (keywords) or memory_remove + memory_add.`,
  ].join("\n");
}

/**
 * Soft-budget warning for the always-injected pool (`important: true`). Nothing
 * is rejected — the pool simply costs context in every session, so the card says
 * how big it is and what to do about it.
 */
export function buildImportantPoolWarning(
  pool: { count: number; chars: number; preview: string[] },
  limits: { maxEntries: number; maxChars: number },
): string {
  const lines = [
    `Important pool is large: ${pool.count} entries / ${pool.chars} chars are injected into the start of every session.`,
    `Demote or remove what is no longer worth that cost (memory_replace with important:false, or memory_remove) — reserve "important" for facts that help in EVERY session, not just the current project or task.`,
  ];
  if (pool.preview.length > 0) {
    lines.push(`Current pool (${pool.preview.length} of ${pool.count}):`);
    for (const item of pool.preview) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

/**
 * Non-blocking scope warning. The FIRST LINE is the gist — the tool card shows it
 * collapsed, so it has to stand alone; the rest carries the rule, the
 * "nothing was blocked" reassurance and the matched snippets.
 */
export function buildScopeHintWarning(hint: ScopeHint, target: string): string {
  return [
    `Scope check: this looks project-specific, not "${target}" — use target "project".`,
    `Repo, path, package and command details belong in "project"; "${target}" holds only what is true in EVERY project. Split the fact if it mixes both.`,
    `Saved as requested — move it with memory_remove + memory_add if the scope is wrong.`,
    `Matched: ${hint.matched.join(", ")}.`,
  ].join("\n");
}
