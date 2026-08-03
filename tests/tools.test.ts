import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTools } from "../src/tools/index.js";

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("workspace-scoped tools", () => {
  it("reads a bounded line range", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "notes.txt"), "one\ntwo\nthree\n");
    const tool = createTools({ workspaceRoot: root }).find((item) => item.def.name === "read_file")!;
    await expect(tool.execute({ path: "notes.txt", startLine: 2, endLine: 3 })).resolves.toBe("2: two\n3: three");
  });

  it("denies writes outside the workspace before execution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    const tool = createTools({ workspaceRoot: root }).find((item) => item.def.name === "write_file")!;
    await expect(tool.execute({ path: "../escape.txt", content: "no" })).rejects.toThrow(/outside workspace/i);
  });

  it("classifies tools with granular risk", () => {
    const tools = createTools({ workspaceRoot: process.cwd() });
    expect(tools.find((item) => item.def.name === "read_file")?.risk).toBe("read");
    expect(tools.find((item) => item.def.name === "run_command")?.risk).toBe("process");
  });
});
