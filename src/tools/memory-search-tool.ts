import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats, getImportantMemories, type SqliteMemoryEntry } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

function mutationTarget(entry: { target: "memory" | "user" | "failure"; project: string | null }): "memory" | "user" | "failure" | "project" {
  // A project name scopes ordinary memory entries, but project-attributed
  // failures still live in (and must be mutated through) the failure store.
  return entry.target === "memory" && entry.project ? "project" : entry.target;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : "global";
}

/** One result block: scope, mutation target, important marker, keys, dates. */
function formatResultLine(entry: SqliteMemoryEntry): string {
  const target = entry.target === 'memory' && entry.project ? 'project' : entry.target;
  const projectLabel = `scope=${scopeLabel(entry.project)}`;
  const targetLabel = entry.target === 'user' ? '\u{1F464}' : entry.target === 'failure' ? '\u26A0\uFE0F' : '\u{1F9E0}';
  const categoryLabel = entry.category ? ` [${entry.category}]` : '';
  const importantLabel = entry.important ? ' [important]' : '';
  const keywords = (entry.keywords ?? []).join(", ");
  return `${targetLabel} ${projectLabel} [target=${target}]${categoryLabel}${importantLabel} ${entry.content}\n`
    + `   Created: ${entry.created} | Last used: ${entry.lastReferenced}`
    + (keywords ? ` | keys: ${keywords}` : "");
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

target="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.

Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Search query. Use natural language or specific terms. Omit only together with important:true.' })),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure', 'project'] as const, { description: 'Filter by target type: memory, user, failure, or project-attributed memories.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
      important: Type.Optional(Type.Boolean({ description: 'List only always-injected (important:true) entries — the pool that is injected into every session. No query needed.' })),
    }),
    execute: async (_id: string, args: { query?: string; project?: string; target?: 'memory' | 'user' | 'failure' | 'project'; category?: string; limit?: number; important?: boolean }) => {
      const query = args.query ?? '';
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(args.limit || 10, 20);

      if (args.important === true) {
        // List the always-injected pool (every scope) for curation: it costs
        // context in every session, so it has to be inspectable in one call.
        const pool = getImportantMemories(dbManager);
        if (pool.length === 0) {
          const message = 'No always-injected (important) entries. Use memory_add with important:true for facts that must be present in every session.';
          return { content: [{ type: 'text' as const, text: message }], details: { success: true, count: 0, message } };
        }
        const lines = [
          `${pool.length} always-injected ${pool.length === 1 ? 'entry' : 'entries'} (injected into every session in their scope):`,
          '',
        ];
        for (const entry of pool) lines.push(formatResultLine(entry), '');
        const output = lines.join('\n').trim();
        const finalResult: SearchResult = { success: true, count: pool.length, output };
        return { content: [{ type: 'text' as const, text: output }], details: finalResult };
      }

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use memory_add to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchMemories(dbManager, query, { project, target, category, limit });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`;

      for (const entry of results) output += `${formatResultLine(entry)}\n\n`;

      const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
