import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject, loadProjectInstructions } from "../src/project.js";

const created: string[] = [];
afterEach(() => created.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("project intelligence", () => {
  it("loads FORGE.md first and includes compatible AGENTS.md guidance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-project-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "FORGE.md"), "Forge rules");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Shared rules");
    expect(loadProjectInstructions(root)).toEqual([
      { file: "FORGE.md", content: "Forge rules" },
      { file: "AGENTS.md", content: "Shared rules" },
    ]);
  });

  it("detects Node, TypeScript, and package scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-project-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }));
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
    expect(detectProject(root)).toMatchObject({ languages: ["TypeScript"], packageManager: "npm", scripts: ["build", "test"] });
  });
});
