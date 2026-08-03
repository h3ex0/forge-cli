import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import fg from "fast-glob";
import type { ToolDef } from "../providers/types.js";

export interface ToolSpec {
  def: ToolDef;
  destructive: boolean;
  execute: (args: any) => Promise<string>;
}

const MAX_OUTPUT = 6000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[truncated]" : s;
}

export const tools: ToolSpec[] = [
  {
    def: {
      name: "read_file",
      description: "Read the contents of a file at a given path (relative to cwd or absolute).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path to read" } },
        required: ["path"],
      },
    },
    destructive: false,
    async execute({ path: p }) {
      const content = fs.readFileSync(p, "utf-8");
      return clip(content);
    },
  },
  {
    def: {
      name: "write_file",
      description: "Write (create or overwrite) a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
    destructive: true,
    async execute({ path: p, content }) {
      const dir = path.dirname(p);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, content, "utf-8");
      return `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${p}`;
    },
  },
  {
    def: {
      name: "edit_file",
      description: "Replace an exact string match in a file with new text. old_string must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    destructive: true,
    async execute({ path: p, old_string, new_string }) {
      const original = fs.readFileSync(p, "utf-8");
      const occurrences = original.split(old_string).length - 1;
      if (occurrences === 0) throw new Error("old_string not found in file");
      if (occurrences > 1) throw new Error(`old_string is not unique (${occurrences} matches)`);
      const updated = original.replace(old_string, new_string);
      fs.writeFileSync(p, updated, "utf-8");
      return `Edited ${p}`;
    },
  },
  {
    def: {
      name: "list_dir",
      description: "List files and directories at a given path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path, default '.'" } },
        required: [],
      },
    },
    destructive: false,
    async execute({ path: p }) {
      const dir = p || ".";
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n");
    },
  },
  {
    def: {
      name: "glob_search",
      description: "Find files matching a glob pattern, e.g. '**/*.ts'.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, cwd: { type: "string" } },
        required: ["pattern"],
      },
    },
    destructive: false,
    async execute({ pattern, cwd }) {
      const results = await fg(pattern, { cwd: cwd || ".", dot: false, onlyFiles: false });
      return clip(results.join("\n") || "(no matches)");
    },
  },
  {
    def: {
      name: "grep_search",
      description: "Search for a regex pattern across files matching a glob (default '**/*').",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          glob: { type: "string", description: "File glob, default '**/*'" },
          cwd: { type: "string" },
        },
        required: ["pattern"],
      },
    },
    destructive: false,
    async execute({ pattern, glob, cwd }) {
      const files = await fg(glob || "**/*", { cwd: cwd || ".", onlyFiles: true, dot: false });
      const re = new RegExp(pattern);
      const hits: string[] = [];
      for (const f of files) {
        const full = path.join(cwd || ".", f);
        let content: string;
        try {
          content = fs.readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        lines.forEach((line, i) => {
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
        if (hits.length > 200) break;
      }
      return clip(hits.join("\n") || "(no matches)");
    },
  },
  {
    def: {
      name: "bash_exec",
      description: "Execute a shell command and return its stdout/stderr. Use with caution.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
    destructive: true,
    async execute({ command, cwd }) {
      return new Promise((resolve, reject) => {
        exec(command, { cwd: cwd || process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && !stdout && !stderr) {
            reject(err);
            return;
          }
          const out = `${stdout}${stderr ? "\n[stderr]\n" + stderr : ""}`;
          resolve(clip(out || "(no output)"));
        });
      });
    },
  },
  {
    def: {
      name: "web_fetch",
      description: "Fetch the text content of a URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    destructive: false,
    async execute({ url }) {
      const res = await fetch(url, { headers: { "User-Agent": "forge-cli/0.1" } });
      const text = await res.text();
      return clip(text);
    },
  },
];

export function getToolDefs(): ToolDef[] {
  return tools.map((t) => t.def);
}

export function findTool(name: string): ToolSpec | undefined {
  return tools.find((t) => t.def.name === name);
}
