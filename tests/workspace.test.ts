import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../src/security/workspace.js";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("workspace path enforcement", () => {
  it("allows paths inside the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-workspace-"));
    created.push(root);
    fs.mkdirSync(path.join(root, "src"));
    expect(resolveWorkspacePath(root, "src/file.ts", { allowMissing: true })).toBe(path.join(root, "src", "file.ts"));
  });

  it("denies parent traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-workspace-"));
    created.push(root);
    expect(() => resolveWorkspacePath(root, "../secret.txt", { allowMissing: true })).toThrow(/outside workspace/i);
  });
});
