import type { SharedOutputView } from "./shared-output-view.js";
import { normalizeSharedOutputView } from "./shared-output-view.js";

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function resultData(result: unknown): Record<string, any> | null {
  const resultRecord = record(result);
  const details = record(resultRecord?.details);
  if (details && Object.keys(details).length > 0) return details;

  const content = resultRecord?.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const text = record(content[0])?.text;
  if (typeof text !== "string" || !text.trimStart().startsWith("{")) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function warningText(data: Record<string, any>): string | null {
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((value: unknown) => typeof value === "string" && value.trim())
    : [];
  return firstText(data.warning, ...warnings);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Warnings may be multi-line (first line = gist, rest = detail). The collapsed
 * summary shows only the gist, shortened — the full text lives in the expansion.
 */
const COLLAPSED_WARNING_CHARS = 80;
function collapsedWarning(warning: string): string {
  const gist = warning.split(/\r?\n/)[0].trim() || warning;
  return gist.length > COLLAPSED_WARNING_CHARS
    ? `${gist.slice(0, COLLAPSED_WARNING_CHARS - 1).trimEnd()}…`
    : gist;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${project}` : "global";
}

/**
 * Human-readable view of a memory mutation.
 *
 * Collapsed: outcome, target (+category), keywords, store size.
 * Expanded:  the same header plus the entry text that was added, replaced or
 *            removed, rotated-out entries and warnings — instead of the raw
 *            JSON payload the model receives.
 */
export function memoryResultView(result: unknown): SharedOutputView {
  const base = normalizeSharedOutputView(result);
  const data = resultData(result);
  if (!data) return base;

  if (data.success === false || (data.success !== true && firstText(data.error))) {
    const failureReason = firstText(data.error, data.message);
    const lines: string[] = [];
    if (failureReason) lines.push(`Error: ${failureReason}`);
    const failedTarget = firstText(data.target);
    if (failedTarget) lines.push(`target: ${failedTarget}`);
    const hinted = stringList(data.matching_targets);
    if (hinted.length > 0) lines.push(`other targets with a match: ${hinted.join(", ")}`);
    const failedMatches = stringList(data.matches);
    if (failedMatches.length > 0) lines.push("", "Matching entries:", ...failedMatches.map((match) => `  ${match}`));
    const failedEntries = stringList(data.entries);
    if (failedEntries.length > 0) lines.push("", "Current entries:", ...failedEntries.map((entry) => `  ${entry}`));
    return {
      ...base,
      status: "failure",
      summary: failureReason ? `Error · ${failureReason}` : "Error",
      expandedText: lines.length > 0 ? lines.join("\n") : base.expandedText,
    };
  }
  if (data.success !== true) return base;

  const primaryMessage = (firstText(data.message) ?? "").split(/\s*\bWarning:/)[0].trim();
  const evictedEntries = stringList(data.evicted_entries);
  const evicted = typeof data.evicted_count === "number" ? data.evicted_count : evictedEntries.length;
  const outcome = /^Entry added\.$/.test(primaryMessage) || /^Failure memory saved:/.test(primaryMessage) || evicted > 0
    ? "Saved"
    : /^Entry replaced\.$/.test(primaryMessage)
      ? "Replaced"
      : /^Entry removed\.$/.test(primaryMessage)
        ? "Removed"
        : /^Entry already exists/.test(primaryMessage)
          ? "Unchanged"
          : "Updated";
  const target = firstText(data.target);
  const project = firstText(data.project);
  const category = typeof data.category === "string" && data.category.trim()
    ? data.category.trim()
    : data.target === "failure"
      ? primaryMessage.match(/^Failure memory saved:\s*(\S+)/i)?.[1] ?? null
      : null;
  const keywords = stringList(data.keywords);
  const entry = firstText(data.entry);
  const previous = firstText(data.previous_entry);
  const removed = firstText(data.removed_entry);
  const entryCount = typeof data.entry_count === "number" ? data.entry_count : undefined;
  const warning = warningText(data);
  // An add-shaped result reports the entry that is now stored; replace/remove
  // report the previous text instead. Only adds always show a keywords line.
  const added = entry !== null && previous === null && removed === null;
  const keywordsLine = `keys: ${keywords.length > 0 ? keywords.join(", ") : "(none)"}`;
  const showKeywords = added || keywords.length > 0;

  const parts = [outcome];
  if (target) parts.push(`target: ${target}`);
  if (category) parts.push(`category: ${category}`);
  if (showKeywords) parts.push(keywordsLine);
  if (evicted > 0) parts.push(`evicted: ${evicted}`);
  if (entryCount !== undefined) parts.push(countLabel(entryCount, "entry", "entries"));
  // The collapsed line carries only the gist; the full text stays in the expansion.
  if (warning) parts.push(`Warning: ${collapsedWarning(warning)}`);

  const lines = [primaryMessage || `${outcome}.`];
  const meta = [`target: ${target ?? "?"}`, `scope=${scopeLabel(project)}`];
  if (category) meta.push(`category: ${category}`);
  if (entryCount !== undefined) meta.push(countLabel(entryCount, "entry", "entries"));
  lines.push(meta.join(" · "));
  if (showKeywords) lines.push(keywordsLine);
  if (entry) lines.push("", entry);
  if (previous) lines.push("", "was:", previous);
  if (removed) lines.push("", "removed:", removed);
  if (evictedEntries.length > 0) {
    lines.push("", `Rotated out ${countLabel(evictedEntries.length, "entry", "entries")}:`);
    for (const item of evictedEntries) lines.push(`  ${item}`);
  }
  if (warning) lines.push("", `Warning: ${warning}`);

  return { ...base, status: "success", summary: parts.join(" · "), expandedText: lines.join("\n") };
}

export function searchResultView(result: unknown): SharedOutputView {
  const base = normalizeSharedOutputView(result);
  const data = resultData(result);
  if (!data || data.success === false) return base;
  if (typeof data.count === "number") {
    return { ...base, summary: data.count === 1 ? "Found 1 result" : `Found ${data.count} results` };
  }
  return base;
}

const SKILL_OUTCOMES: Array<[RegExp, string]> = [
  [/created/i, "Created"],
  [/updated|patched/i, "Updated"],
  [/moved/i, "Moved"],
  [/deleted|removed/i, "Deleted"],
];

/**
 * Human-readable view of a skill-manager call:
 * collapsed — outcome plus the skill id;
 * expanded  — message, id, scope, path and the markdown body that was written.
 */
export function skillResultView(result: unknown): SharedOutputView {
  const base = normalizeSharedOutputView(result);
  const data = resultData(result);
  if (!data) return base;

  if (data.success === false) {
    const failureReason = firstText(data.error, data.message);
    const lines: string[] = [];
    if (failureReason) lines.push(`Error: ${failureReason}`);
    const failedSkillId = firstText(data.skillId, data.skill_id);
    if (failedSkillId) lines.push(`skill_id: ${failedSkillId}`);
    const similar = stringList(data.similarSkillIds);
    if (similar.length > 0) lines.push(`similar skills: ${similar.join(", ")}`);
    const suggested = firstText(data.suggestedAction);
    if (suggested) lines.push(`suggested action: ${suggested}`);
    return {
      ...base,
      status: "failure",
      summary: failureReason ? `Error · ${failureReason}` : "Error",
      expandedText: lines.length > 0 ? lines.join("\n") : base.expandedText,
    };
  }
  if (Array.isArray(data.skills)) {
    const entries = data.skills as Array<Record<string, unknown>>;
    const lines = [`${countLabel(entries.length, "skill")} available`];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const entryId = firstText(entry.skillId, entry.skill_id, entry.name);
      if (!entryId) continue;
      const entryDescription = firstText(entry.description);
      lines.push(`  ${entryId}${entryDescription ? ` — ${entryDescription}` : ""}`);
    }
    return {
      ...base,
      summary: `Skills: ${entries.length} available`,
      expandedText: lines.length > 1 ? lines.join("\n") : base.expandedText,
    };
  }

  const message = firstText(data.message);
  const skillId = firstText(data.skillId, data.skill_id);
  const scope = firstText(data.scope);
  const skillPath = firstText(data.path);
  const section = firstText(data.section);
  const body = firstText(data.body);
  const outcome = message ? SKILL_OUTCOMES.find(([pattern]) => pattern.test(message))?.[1] ?? null : null;
  const name = firstText(data.displayName, data.name);

  const summary = outcome
    ? `${outcome} · ${skillId ?? name ?? "skill"}`
    : (name ?? skillId)
      ? `Skill: ${name ?? skillId}`
      : message ?? "Skill updated";

  const lines: string[] = [];
  if (message) lines.push(message);
  const meta: string[] = [];
  if (skillId) meta.push(`skill_id: ${skillId}`);
  if (scope) meta.push(`scope: ${scope}`);
  if (section) meta.push(`section: ${section}`);
  if (skillPath) meta.push(`path: ${skillPath}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  if (body) lines.push("", body);

  return {
    ...base,
    summary,
    expandedText: lines.length > 0 ? lines.join("\n") : base.expandedText,
  };
}
