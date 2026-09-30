import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContext } from "../../src/prompt-context.js";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "../../src/constants.js";

describe("buildPromptContext", () => {
  const store = {
    formatForSystemPrompt: () => "<memory-context>MEMORY</memory-context>",
  } as any;

  const projectStore = {
    formatProjectBlock: (projectName: string) => `<memory-context>PROJECT ${projectName}</memory-context>`,
  } as any;

  it("returns policy only in policy-only mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
    assert.match(result, /memory_search/);
    assert.match(result, /Accepted memory categories/);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /Use category only for categorized failure\/lesson searches/);
    assert.match(result, /session_search: search indexed past conversation messages/);
    assert.match(result, /skill_manage: list, view, create, patch, update, and delete procedural skills/);
    assert.match(result, /Always pass scope explicitly on create/);
    // The scope rule that the live mis-scoping incident asked for.
    assert.match(result, /classify by DOMAIN, not by the speech act/i);
    assert.match(result, /even when it was phrased as a standing instruction/);
    assert.match(result, /stays true in EVERY project/);
    assert.match(result, /Do not create skills for one-off task state/);
    assert.doesNotMatch(result, /category="preference"/);
    assert.doesNotMatch(result, /inspect, and update procedural skills/);
    assert.doesNotMatch(result, /memory_search: search relevant user, project, session, failure, and skill memories/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("returns the full policy prompt when policy style is full", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "full" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
  });

  it("carries the scope rule in the compact policy too", async () => {
    assert.match(MEMORY_POLICY_PROMPT_COMPACT, /Classify by domain, not by the speech act/);
    assert.match(MEMORY_POLICY_PROMPT_COMPACT, /"user" only holds what stays true in EVERY project/);
  });

  it("carries the keywords rule in both policies", async () => {
    assert.match(MEMORY_POLICY_PROMPT, /Keywords — automatic retrieval matches ONLY them/);
    assert.match(MEMORY_POLICY_PROMPT, /An entry saved without keywords is never surfaced that way/);
    assert.match(MEMORY_POLICY_PROMPT, /should pull THIS entry when it later shows up in a user prompt or a bash command/);
    assert.match(MEMORY_POLICY_PROMPT, /Generic words match everything and only add noise/);
    assert.match(MEMORY_POLICY_PROMPT_COMPACT, /matches the keywords column ONLY/);
  });

  it("returns the compact policy prompt when policy style is compact", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT_COMPACT);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /scope is required: global for transferable workflows, project for repo-specific ones/);
    assert.match(result, /Do not use memory_search for generic questions/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("returns custom policy text when policy style is custom", async () => {
    const customText = "<memory-policy>Use local custom policy.</memory-policy>";
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "custom", memoryPolicyCustomText: customText },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, customText);
  });

  it("falls back to compact policy when custom policy text is blank", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "custom", memoryPolicyCustomText: "  \n\t  " },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT_COMPACT);
  });

  it("returns empty context when policy style is none", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "none" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, "");
  });

  it("returns legacy memory blocks in legacy-inject mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );

    assert.match(result, /MEMORY/);
    assert.match(result, /PROJECT demo/);
    assert.doesNotMatch(result, /<memory-policy>/);
  });

  it("never injects a standing block: always-injected entries use their own session block", async () => {
    const policyOnly = await buildPromptContext({ memoryMode: "policy-only" }, store, projectStore, "demo");
    assert.strictEqual(policyOnly, MEMORY_POLICY_PROMPT);

    const noPolicy = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "none" },
      store,
      projectStore,
      "demo",
    );
    assert.strictEqual(noPolicy, "");

    const legacy = await buildPromptContext({ memoryMode: "legacy-inject" }, store, projectStore, "demo");
    assert.doesNotMatch(legacy, /standing-instructions/);
    assert.match(legacy, /MEMORY<\/memory-context>/);
  });
});
