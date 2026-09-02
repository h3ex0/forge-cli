import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let workspace: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
  process.env.FORGE_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.FORGE_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("workspace memory", () => {
  it("remembers, lists, forgets, and refuses duplicates", async () => {
    const memory = await import("../src/memory.js");

    expect(memory.readMemory(workspace)).toEqual([]);
    const first = memory.rememberFact(workspace, "Tests run with vitest, not jest.");
    expect(first).toBeDefined();
    // Same fact twice shouldn't accumulate — the prompt section would repeat it.
    expect(memory.rememberFact(workspace, "Tests run with vitest, not jest.")).toBeUndefined();
    expect(memory.readMemory(workspace)).toHaveLength(1);

    memory.rememberFact(workspace, "The TUI is a single borderless pane.");
    expect(memory.readMemory(workspace)).toHaveLength(2);

    expect(memory.forgetFact(workspace, first!.id)).toBe(true);
    expect(memory.forgetFact(workspace, first!.id)).toBe(false);
    expect(memory.readMemory(workspace).map((entry) => entry.text)).toEqual(["The TUI is a single borderless pane."]);

    memory.clearMemory(workspace);
    expect(memory.readMemory(workspace)).toEqual([]);
  });

  it("scopes memory per workspace", async () => {
    const memory = await import("../src/memory.js");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws2-"));
    try {
      memory.rememberFact(workspace, "belongs to workspace one");
      expect(memory.readMemory(other)).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("renders a bounded prompt section, dropping oldest facts past the budget", async () => {
    const memory = await import("../src/memory.js");
    expect(memory.memoryPromptSection(workspace)).toBe("");

    memory.rememberFact(workspace, "oldest fact");
    memory.rememberFact(workspace, "newest fact");
    const section = memory.memoryPromptSection(workspace);
    expect(section).toContain("Remembered about this workspace");
    expect(section).toContain("newest fact");

    // With a budget that only fits one line, the newest survives.
    const tight = memory.memoryPromptSection(workspace, 20);
    expect(tight).toContain("newest fact");
    expect(tight).not.toContain("oldest fact");
  });
});

describe("skills", () => {
  const writeSkill = (dir: string, file: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), body, "utf-8");
  };

  it("discovers workspace and user skills, and parses frontmatter", async () => {
    const skills = await import("../src/skills.js");
    writeSkill(path.join(workspace, ".forge", "skills"), "review.md",
      "---\nname: code-review\ndescription: How we review changes here\n---\n\nAlways check the tests first.");
    writeSkill(path.join(home, "skills"), "release.md", "# Release\n\nTag, then publish.");

    const found = skills.listSkills(workspace);
    expect(found.map((skill) => skill.name).sort()).toEqual(["code-review", "release"]);

    const review = skills.findSkill(workspace, "code-review")!;
    expect(review.scope).toBe("workspace");
    expect(review.description).toBe("How we review changes here");
    expect(review.body).toContain("Always check the tests first.");
    expect(review.body).not.toContain("---"); // frontmatter stripped

    // No frontmatter: description falls back to the first non-heading line.
    expect(skills.findSkill(workspace, "release")!.description).toBe("Tag, then publish.");
  });

  it("lets a workspace skill shadow a user skill of the same name", async () => {
    const skills = await import("../src/skills.js");
    writeSkill(path.join(home, "skills"), "deploy.md", "---\nname: deploy\n---\nuser version");
    writeSkill(path.join(workspace, ".forge", "skills"), "deploy.md", "---\nname: deploy\n---\nworkspace version");

    const found = skills.listSkills(workspace);
    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe("workspace");
    expect(found[0].body).toContain("workspace version");
  });

  it("lists skills in the prompt section, and matches by prefix", async () => {
    const skills = await import("../src/skills.js");
    expect(skills.skillsPromptSection(workspace)).toBe("");
    writeSkill(path.join(workspace, ".forge", "skills"), "migrations.md",
      "---\nname: migrations\ndescription: Writing safe schema migrations\n---\nbody");

    expect(skills.skillsPromptSection(workspace)).toContain("migrations: Writing safe schema migrations");
    expect(skills.findSkill(workspace, "migra")?.name).toBe("migrations");
    expect(skills.findSkill(workspace, "nope")).toBeUndefined();
  });
});

describe("session ids", () => {
  it("summarises sessions newest first, titled by the first thing asked", async () => {
    const session = await import("../src/session.js");

    session.saveSession("s20260101-0000-aaaa", [
      { role: "system", content: "sys" },
      { role: "user", content: "  \nAdd a health check endpoint\nmore detail" },
      { role: "assistant", content: "done" },
    ]);
    // Distinct mtimes so the ordering assertion is meaningful.
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.saveSession("s20260102-0000-bbbb", [{ role: "user", content: "Rename the config module" }]);

    const summaries = session.listSessionSummaries();
    expect(summaries.map((entry) => entry.id)).toEqual(["s20260102-0000-bbbb", "s20260101-0000-aaaa"]);
    expect(summaries[1].title).toBe("Add a health check endpoint");
    expect(summaries[1].messageCount).toBe(2); // system message not counted

    session.deleteSession("s20260102-0000-bbbb");
    expect(session.listSessionSummaries().map((entry) => entry.id)).toEqual(["s20260101-0000-aaaa"]);
  });

  it("mints unique, time-ordered session ids", async () => {
    const session = await import("../src/session.js");
    const ids = new Set(Array.from({ length: 50 }, () => session.newSessionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(session.validateSessionName(id)).toBe(id);
  });

  it("survives an unreadable session file instead of failing the whole list", async () => {
    const session = await import("../src/session.js");
    session.saveSession("s20260101-0000-good", [{ role: "user", content: "fine" }]);
    fs.writeFileSync(path.join(home, "sessions", "broken.json"), "{ not json", "utf-8");

    expect(session.listSessionSummaries().map((entry) => entry.id)).toEqual(["s20260101-0000-good"]);
  });
});
