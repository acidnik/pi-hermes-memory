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
 * Non-blocking warning text. The FIRST LINE is the gist — the tool card shows it
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
