import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildScopeHintWarning, detectProjectScopeSignals } from "../../src/store/scope-lint.js";

describe("scope lint", () => {
  // The live incident: a per-repo release contract saved to the user profile.
  const deployContract = 'Standing release contract for pi-better-paste-markers (/home/nik/src/pi-better-paste-markers): '
    + 'when Nik says "deploy"/"деплой", do the FULL release without further questions: (1) compare local package.json '
    + 'version vs `npm view pi-better-paste-markers version`, (2) bump via `npm version X.Y.Z --no-git-tag-version`, '
    + '(3) push origin main, (4) `npm publish` unattended.';

  it("flags the per-repo release contract that was mis-scoped live", () => {
    const hint = detectProjectScopeSignals(deployContract);
    assert.ok(hint, "expected a scope hint");
    assert.ok(hint.matched.some((snippet) => snippet.includes("/home/nik/src/pi-better-paste-markers")));
    assert.ok(hint.matched.length <= 4);
  });

  it("flags absolute paths, forge URLs, scoped packages and package commands", () => {
    for (const content of [
      "Repos live under /opt/work when Nik is on the server.",
      "Push to github.com/acidnik/pi-hermes-memory after the tests pass.",
      "git@github.com:acidnik/pi-hermes-memory.git is the origin.",
      "Install @earendil-works/pi-coding-agent first.",
      "Run `cargo publish --dry-run` before tagging.",
    ]) {
      assert.ok(detectProjectScopeSignals(content), `expected a hint for: ${content}`);
    }
  });

  it("needs two weak signals, because one alone is a normal preference", () => {
    // One weak signal alone: not enough.
    assert.equal(detectProjectScopeSignals("Nik edits package.json by hand."), null);
    assert.equal(detectProjectScopeSignals("Nik prefers this repo to stay small."), null);
    assert.equal(detectProjectScopeSignals("Nik always runs npm run test before pushing."), null);
    // Two weak signals together: project-shaped.
    const hint = detectProjectScopeSignals("This repo keeps its scripts in package.json.");
    assert.ok(hint, "expected a hint for two weak signals");
  });

  it("stays quiet for genuine cross-project user facts", () => {
    for (const content of [
      "Nik prefers tabs over spaces and short commit messages.",
      "Nik's timezone is +04 and he works late.",
      "Nik dislikes auto-commit and wants explicit permission before any push.",
      "Nik uses deepseek-v4-flash via opencode-go routing in his pi setup.",
      "Nik reviews internal result fields before exposing them to users.",
      "Nik's pi startup model comes from settings.json.",
    ]) {
      assert.equal(detectProjectScopeSignals(content), null, `false positive for: ${content}`);
    }
  });

  it("truncates long snippets so the warning stays readable", () => {
    const hint = detectProjectScopeSignals(`Nik keeps the checkout at /home/nik/src/${"nested/".repeat(12)}project.`);
    assert.ok(hint);
    assert.ok(hint.matched[0].length <= 48, `snippet too long: ${hint.matched[0]}`);
    assert.ok(hint.matched[0].endsWith("…"));
  });

  it("describes the rule and says the write was not blocked", () => {
    const hint = detectProjectScopeSignals(deployContract);
    assert.ok(hint);
    const warning = buildScopeHintWarning(hint, "user");
    assert.match(warning, /^Scope check: this looks project-specific, not "user" — use target "project"\./);
    assert.match(warning, /belong in "project"/);
    assert.match(warning, /Saved as requested/);
    // The first line is the gist the collapsed card shows.
    assert.strictEqual(warning.split("\n")[0].length <= 80, true);
    for (const snippet of hint.matched) {
      assert.ok(warning.includes(snippet), `warning should mention ${snippet}`);
    }
  });
});

describe("scope guidance text", () => {
  it("states the rule in the tool description", async () => {
    const { MEMORY_TOOL_DESCRIPTION } = await import("../../src/constants.js");
    assert.match(MEMORY_TOOL_DESCRIPTION, /SCOPE RULE -- classify by DOMAIN, not by the speech act/);
    assert.match(MEMORY_TOOL_DESCRIPTION, /even when it was phrased as a standing user instruction/);
    assert.match(MEMORY_TOOL_DESCRIPTION, /"if I switched to another repository, would this still be true\?" No -> "project"/);
  });

  it("states the rule in the background review / flush / correction routing guidance", async () => {
    const { buildMemoryTargetRoutingGuidance } = await import("../../src/constants.js");
    for (const hasProjectStore of [true, false]) {
      const guidance = buildMemoryTargetRoutingGuidance(hasProjectStore);
      assert.match(guidance, /classify by domain, not by the speech act/i);
      assert.match(guidance, /it is project-scoped: use target "project"/);
      assert.match(guidance, /Split mixed facts/);
    }
  });
});
