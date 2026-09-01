import fs from "node:fs";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import fg from "fast-glob";
import { validatePublicUrl } from "../security/network.js";
import { resolveWorkspacePath } from "../security/workspace.js";
const MAX_OUTPUT = 24_000;
const ajv = new Ajv2020({ allErrors: true });
// Keyed by workspace root so a plan set with todo_write survives across
// turns of the same chat session (each turn rebuilds the tool list).
const todoStore = new Map();
function renderTodos(items) {
    if (!items.length)
        return "(no todos)";
    const marker = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
    return items.map((item) => `${marker[item.status]} ${item.content}`).join("\n");
}
function clip(value) {
    return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n…[truncated]` : value;
}
function text(args, key, fallback) {
    const value = args[key];
    if (typeof value === "string")
        return value;
    if (fallback !== undefined)
        return fallback;
    throw new Error(`Expected string argument: ${key}`);
}
function numberArg(args, key, fallback) {
    const value = args[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function strings(args, key) {
    const value = args[key];
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new Error(`Expected string array: ${key}`);
    return value;
}
function workspacePattern(args, key, fallback) {
    const value = text(args, key, fallback);
    const normalized = value.replace(/\\/g, "/");
    if (path.isAbsolute(value) || normalized.split("/").includes("..")) {
        throw new Error(`Glob pattern must stay inside the workspace: ${value}`);
    }
    return value;
}
function runFile(file, args, cwd, timeout = 60_000, signal) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { cwd, timeout, signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr)
                return reject(error);
            resolve(clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() || "(no output)"));
        });
    });
}
function tool(def, risk, execute) {
    const validate = ajv.compile(def.parameters);
    return {
        def,
        risk,
        destructive: risk !== "read",
        async execute(args, signal) {
            if (!validate(args))
                throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
            return execute(args, signal);
        },
    };
}
export function createTools(context) {
    const root = fs.realpathSync(path.resolve(context.workspaceRoot));
    return [
        tool({
            name: "read_file",
            description: "Read a UTF-8 file inside the workspace, optionally selecting an inclusive line range.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    startLine: { type: "integer", minimum: 1 },
                    endLine: { type: "integer", minimum: 1 },
                },
                required: ["path"],
                additionalProperties: false,
            },
        }, "read", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"));
            const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
            if (lines.at(-1) === "")
                lines.pop();
            const start = Math.max(1, numberArg(args, "startLine", 1));
            const end = Math.min(lines.length, numberArg(args, "endLine", lines.length));
            return clip(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"));
        }),
        tool({
            name: "file_info",
            description: "Inspect a workspace file's type, size, timestamps, and line count without reading its contents.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        }, "read", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"));
            const stat = fs.statSync(file);
            const relative = path.relative(root, file) || ".";
            let lines;
            if (stat.isFile() && stat.size <= 10 * 1024 * 1024) {
                const content = fs.readFileSync(file, "utf-8");
                lines = content.length ? content.split(/\r?\n/).length : 0;
            }
            return JSON.stringify({ path: relative, type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", bytes: stat.size, lines, modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() }, null, 2);
        }),
        tool({
            name: "hash_file",
            description: "Calculate a SHA-256 digest for a workspace file.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        }, "read", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"));
            if (!fs.statSync(file).isFile())
                throw new Error("Hash target must be a file.");
            return `sha256  ${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}  ${path.relative(root, file)}`;
        }),
        tool({
            name: "json_query",
            description: "Read a value from a workspace JSON file using an RFC 6901 JSON Pointer.",
            parameters: { type: "object", properties: { path: { type: "string" }, pointer: { type: "string" } }, required: ["path"], additionalProperties: false },
        }, "read", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"));
            let value = JSON.parse(fs.readFileSync(file, "utf-8"));
            const pointer = text(args, "pointer", "");
            if (pointer && !pointer.startsWith("/"))
                throw new Error("JSON Pointer must be empty or start with '/'.");
            for (const segment of pointer.split("/").slice(1)) {
                const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
                if (value === null || typeof value !== "object" || !(key in value))
                    throw new Error(`JSON Pointer segment not found: ${key}`);
                value = value[key];
            }
            return clip(JSON.stringify(value, null, 2) ?? "undefined");
        }),
        tool({
            name: "write_file",
            description: "Create or overwrite a UTF-8 file inside the workspace.",
            parameters: {
                type: "object",
                properties: { path: { type: "string" }, content: { type: "string" } },
                required: ["path", "content"],
                additionalProperties: false,
            },
        }, "write", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"), { allowMissing: true });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const content = text(args, "content");
            const temporary = `${file}.forge-tmp-${process.pid}`;
            fs.writeFileSync(temporary, content, "utf-8");
            fs.renameSync(temporary, file);
            return `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path.relative(root, file)}`;
        }),
        tool({
            name: "edit_file",
            description: "Replace one exact string match in a workspace file.",
            parameters: {
                type: "object",
                properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
                required: ["path", "old_string", "new_string"],
                additionalProperties: false,
            },
        }, "write", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"));
            const original = fs.readFileSync(file, "utf-8");
            const oldValue = text(args, "old_string");
            const occurrences = original.split(oldValue).length - 1;
            if (occurrences !== 1)
                throw new Error(occurrences ? `old_string is not unique (${occurrences} matches)` : "old_string not found");
            fs.writeFileSync(file, original.replace(oldValue, text(args, "new_string")), "utf-8");
            return `Edited ${path.relative(root, file)}`;
        }),
        tool({
            name: "list_dir",
            description: "List files and directories inside a workspace directory.",
            parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
        }, "read", async (args) => {
            const directory = resolveWorkspacePath(root, text(args, "path", "."));
            return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).join("\n");
        }),
        tool({
            name: "file_tree",
            description: "Return an ignore-aware workspace file tree.",
            parameters: { type: "object", properties: { pattern: { type: "string" } }, additionalProperties: false },
        }, "read", async (args) => clip((await fg(workspacePattern(args, "pattern", "**/*"), { cwd: root, dot: false, onlyFiles: false, ignore: [".git/**", "node_modules/**", "dist/**"] })).join("\n"))),
        tool({
            name: "workspace_stats",
            description: "Summarize workspace file counts, sizes, extensions, and largest files while respecting common ignores.",
            parameters: { type: "object", properties: { pattern: { type: "string" } }, additionalProperties: false },
        }, "read", async (args) => {
            const files = await fg(workspacePattern(args, "pattern", "**/*"), { cwd: root, dot: false, onlyFiles: true, ignore: [".git/**", "node_modules/**", "dist/**"] });
            const extensions = new Map();
            const sizes = [];
            let totalBytes = 0;
            for (const relative of files.slice(0, 20_000)) {
                const bytes = fs.statSync(resolveWorkspacePath(root, relative)).size;
                totalBytes += bytes;
                sizes.push({ path: relative, bytes });
                const extension = path.extname(relative).toLowerCase() || "[none]";
                extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
            }
            return JSON.stringify({ files: files.length, scannedFiles: sizes.length, bytes: totalBytes, extensions: Object.fromEntries([...extensions].sort((a, b) => b[1] - a[1]).slice(0, 20)), largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 10) }, null, 2);
        }),
        tool({
            name: "glob_search",
            description: "Find workspace paths matching a glob.",
            parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
        }, "read", async (args) => clip((await fg(workspacePattern(args, "pattern", "**/*"), { cwd: root, dot: false, onlyFiles: false, ignore: [".git/**", "node_modules/**"] })).join("\n") || "(no matches)")),
        tool({
            name: "grep_search",
            description: "Search workspace text files with a regular expression.",
            parameters: {
                type: "object",
                properties: { pattern: { type: "string" }, glob: { type: "string" } },
                required: ["pattern"],
                additionalProperties: false,
            },
        }, "read", async (args) => {
            const regex = new RegExp(text(args, "pattern"));
            const files = await fg(workspacePattern(args, "glob", "**/*"), { cwd: root, onlyFiles: true, dot: false, ignore: [".git/**", "node_modules/**", "dist/**"] });
            const hits = [];
            for (const relative of files) {
                let content;
                try {
                    content = fs.readFileSync(path.join(root, relative), "utf-8");
                }
                catch {
                    continue;
                }
                for (const [index, line] of content.split(/\r?\n/).entries()) {
                    regex.lastIndex = 0;
                    if (regex.test(line))
                        hits.push(`${relative}:${index + 1}: ${line.trim()}`);
                    if (hits.length >= 200)
                        return clip(hits.join("\n"));
                }
            }
            return hits.length ? clip(hits.join("\n")) : "(no matches)";
        }),
        tool({
            name: "run_command",
            description: "Run an executable with a structured argument array inside the workspace.",
            parameters: {
                type: "object",
                properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 100, maximum: 300000 } },
                required: ["command"],
                additionalProperties: false,
            },
        }, "process", async (args, signal) => runFile(text(args, "command"), strings(args, "args"), resolveWorkspacePath(root, text(args, "cwd", ".")), numberArg(args, "timeoutMs", 60_000), signal)),
        tool({
            name: "make_directory",
            description: "Create a directory inside the workspace without deleting or overwriting content.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        }, "write", async (args) => {
            const directory = resolveWorkspacePath(root, text(args, "path"), { allowMissing: true });
            fs.mkdirSync(directory, { recursive: true });
            return `Created ${path.relative(root, directory)}`;
        }),
        tool({
            name: "copy_file",
            description: "Copy one workspace file to a new workspace path without overwriting an existing target.",
            parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"], additionalProperties: false },
        }, "write", async (args) => {
            const source = resolveWorkspacePath(root, text(args, "source"));
            const destination = resolveWorkspacePath(root, text(args, "destination"), { allowMissing: true });
            if (!fs.statSync(source).isFile())
                throw new Error("Copy source must be a file.");
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            return `Copied ${path.relative(root, source)} to ${path.relative(root, destination)}`;
        }),
        tool({
            name: "move_file",
            description: "Move or rename a workspace file to a new workspace path without overwriting an existing target.",
            parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"], additionalProperties: false },
        }, "write", async (args) => {
            const source = resolveWorkspacePath(root, text(args, "source"));
            const destination = resolveWorkspacePath(root, text(args, "destination"), { allowMissing: true });
            if (fs.existsSync(destination))
                throw new Error(`Destination already exists: ${path.relative(root, destination)}`);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.renameSync(source, destination);
            return `Moved ${path.relative(root, source)} to ${path.relative(root, destination)}`;
        }),
        tool({
            name: "delete_file",
            description: "Delete a single workspace file. Refuses to delete directories.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        }, "write", async (args) => {
            const file = resolveWorkspacePath(root, text(args, "path"));
            if (!fs.statSync(file).isFile())
                throw new Error("delete_file only removes files; use run_command for directories.");
            fs.unlinkSync(file);
            return `Deleted ${path.relative(root, file)}`;
        }),
        tool({
            name: "todo_write",
            description: "Replace the working plan's todo list. Use this to track multi-step tasks: one item in_progress at a time, mark items completed as you finish them.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                content: { type: "string" },
                                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                            },
                            required: ["content", "status"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["items"],
                additionalProperties: false,
            },
        }, "read", async (args) => {
            const raw = args.items;
            if (!Array.isArray(raw))
                throw new Error("Expected array argument: items");
            const items = raw.map((entry, index) => {
                const record = entry;
                const content = typeof record.content === "string" ? record.content : "";
                const status = record.status;
                if (!content || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
                    throw new Error(`Invalid todo item at index ${index}`);
                }
                return { id: String(index), content, status };
            });
            todoStore.set(root, items);
            return renderTodos(items);
        }),
        tool({
            name: "todo_read",
            description: "Read the working plan's current todo list.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        }, "read", async () => renderTodos(todoStore.get(root) ?? [])),
        tool({
            name: "bash_exec",
            description: "High-risk compatibility escape hatch: execute a shell command inside the workspace.",
            parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"], additionalProperties: false },
        }, "external", async (args, signal) => new Promise((resolve, reject) => {
            exec(text(args, "command"), { cwd: resolveWorkspacePath(root, text(args, "cwd", ".")), timeout: 60_000, signal, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error && !stdout && !stderr)
                    return reject(error);
                resolve(clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() || "(no output)"));
            });
        })),
        ...["status", "diff", "log", "show"].map((subcommand) => tool({
            name: `git_${subcommand}`,
            description: `Run read-only git ${subcommand} in the workspace.`,
            parameters: { type: "object", properties: { args: { type: "array", items: { type: "string" } } }, additionalProperties: false },
        }, "read", async (args, signal) => runFile("git", [subcommand, ...strings(args, "args")], root, 60_000, signal))),
        tool({
            name: "web_fetch",
            description: "Fetch public HTTP(S) text after blocking private and loopback targets.",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
        }, "network", async (args, signal) => {
            let url = await validatePublicUrl(text(args, "url"));
            for (let redirects = 0; redirects <= 5; redirects++) {
                const response = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "forge-cli/0.4" } });
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get("location");
                    if (!location)
                        throw new Error("Redirect response had no location.");
                    url = await validatePublicUrl(new URL(location, url).toString());
                    continue;
                }
                if (!response.ok)
                    throw new Error(`HTTP ${response.status}`);
                return clip(await response.text());
            }
            throw new Error("Too many redirects.");
        }),
    ];
}
export function getToolDefs(context = { workspaceRoot: process.cwd() }) {
    return createTools(context).map((item) => item.def);
}
export function findTool(name, context = { workspaceRoot: process.cwd() }) {
    return createTools(context).find((item) => item.def.name === name);
}
