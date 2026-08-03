import fs from "node:fs";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import fg from "fast-glob";
import { validatePublicUrl } from "../security/network.js";
import { resolveWorkspacePath } from "../security/workspace.js";
const MAX_OUTPUT = 24_000;
const ajv = new Ajv2020({ allErrors: true });
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
        async execute(args) {
            if (!validate(args))
                throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
            return execute(args);
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
        }, "read", async (args) => clip((await fg(text(args, "pattern", "**/*"), { cwd: root, dot: false, onlyFiles: false, ignore: [".git/**", "node_modules/**", "dist/**"] })).join("\n"))),
        tool({
            name: "glob_search",
            description: "Find workspace paths matching a glob.",
            parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
        }, "read", async (args) => clip((await fg(text(args, "pattern"), { cwd: root, dot: false, onlyFiles: false, ignore: [".git/**", "node_modules/**"] })).join("\n") || "(no matches)")),
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
            const files = await fg(text(args, "glob", "**/*"), { cwd: root, onlyFiles: true, dot: false, ignore: [".git/**", "node_modules/**", "dist/**"] });
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
        ...["status", "diff", "log"].map((subcommand) => tool({
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
