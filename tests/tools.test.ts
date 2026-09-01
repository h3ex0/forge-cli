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

  it("rejects glob traversal outside the workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    const tools = createTools({ workspaceRoot: root });
    await expect(tools.find((item) => item.def.name === "glob_search")!.execute({ pattern: "../*" })).rejects.toThrow(/inside the workspace/i);
    await expect(tools.find((item) => item.def.name === "workspace_stats")!.execute({ pattern: "C:\\**\\*" })).rejects.toThrow(/inside the workspace/i);
  });

  it("classifies tools with granular risk", () => {
    const tools = createTools({ workspaceRoot: process.cwd() });
    expect(tools.find((item) => item.def.name === "read_file")?.risk).toBe("read");
    expect(tools.find((item) => item.def.name === "run_command")?.risk).toBe("process");
  });

  it("inspects, hashes, and queries workspace files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "data.json"), JSON.stringify({ project: { name: "forge" } }));
    const tools = createTools({ workspaceRoot: root });
    await expect(tools.find((item) => item.def.name === "file_info")!.execute({ path: "data.json" })).resolves.toContain('"type": "file"');
    await expect(tools.find((item) => item.def.name === "hash_file")!.execute({ path: "data.json" })).resolves.toMatch(/^sha256  [a-f0-9]{64}/);
    await expect(tools.find((item) => item.def.name === "json_query")!.execute({ path: "data.json", pointer: "/project/name" })).resolves.toBe('"forge"');
  });

  it("creates directories and copies without overwriting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "source.txt"), "safe copy");
    const tools = createTools({ workspaceRoot: root });
    await tools.find((item) => item.def.name === "make_directory")!.execute({ path: "nested" });
    const copy = tools.find((item) => item.def.name === "copy_file")!;
    await expect(copy.execute({ source: "source.txt", destination: "nested/copy.txt" })).resolves.toContain("Copied");
    await expect(copy.execute({ source: "source.txt", destination: "nested/copy.txt" })).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, "nested", "copy.txt"), "utf-8")).toBe("safe copy");
  });

  it("summarizes workspace contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "one.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "two.md"), "# Two\n");
    const output = await createTools({ workspaceRoot: root }).find((item) => item.def.name === "workspace_stats")!.execute({});
    expect(JSON.parse(output)).toMatchObject({ files: 2, extensions: { ".ts": 1, ".md": 1 } });
  });

  it("moves files without overwriting an existing target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "source.txt"), "move me");
    fs.writeFileSync(path.join(root, "taken.txt"), "already here");
    const tools = createTools({ workspaceRoot: root });
    const move = tools.find((item) => item.def.name === "move_file")!;
    await expect(move.execute({ source: "source.txt", destination: "taken.txt" })).rejects.toThrow(/already exists/i);
    await expect(move.execute({ source: "source.txt", destination: "nested/moved.txt" })).resolves.toContain("Moved");
    expect(fs.existsSync(path.join(root, "source.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "nested", "moved.txt"), "utf-8")).toBe("move me");
  });

  it("deletes files but refuses directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    fs.writeFileSync(path.join(root, "gone.txt"), "bye");
    fs.mkdirSync(path.join(root, "dir"));
    const tools = createTools({ workspaceRoot: root });
    const del = tools.find((item) => item.def.name === "delete_file")!;
    await expect(del.execute({ path: "dir" })).rejects.toThrow(/only removes files/i);
    await expect(del.execute({ path: "gone.txt" })).resolves.toContain("Deleted");
    expect(fs.existsSync(path.join(root, "gone.txt"))).toBe(false);
  });

  it("tracks a todo list across reads and writes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
    created.push(root);
    const tools = createTools({ workspaceRoot: root });
    const write = tools.find((item) => item.def.name === "todo_write")!;
    const read = tools.find((item) => item.def.name === "todo_read")!;
    await expect(read.execute({})).resolves.toBe("(no todos)");
    await expect(write.execute({ items: [{ content: "Write tests", status: "in_progress" }, { content: "Ship it", status: "pending" }] }))
      .resolves.toBe("[~] Write tests\n[ ] Ship it");
    await expect(read.execute({})).resolves.toBe("[~] Write tests\n[ ] Ship it");
  });
});
