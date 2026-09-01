import fs from "node:fs";
import type { ForgeConfig, PermissionMode } from "../config.js";
import type { ChatMessage } from "../providers/types.js";
import { loadSession, saveSession, defaultSessionName, serializeConversation } from "../session.js";
import { parseSlashCommand } from "../commands/parser.js";
import { slashCommandNames } from "../commands/registry.js";
import { activateLocalModel } from "../runtime/service.js";
import { createTools } from "../tools/index.js";
import { detectProject, loadProjectInstructions } from "../project.js";
import { clearProfileUsage, loadUsageLedger } from "../usage-store.js";
import { resolveWorkspacePath } from "../security/workspace.js";

export type TuiOverlay = "help" | "commands" | "models" | "context" | "sessions";

export type TuiCommandResult =
  | { type: "not-command" }
  | { type: "exit" }
  | { type: "prompt"; prompt: string }
  | { type: "overlay"; overlay: TuiOverlay }
  | { type: "notice"; message: string }
  | { type: "clear" }
  | { type: "load"; messages: ChatMessage[]; name: string }
  | { type: "model-info"; reference: string }
  | { type: "model-pull"; reference: string }
  | { type: "runtime"; operation: "list" | "status" | "start" | "stop"; kind?: string; modelPath?: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "tool-sequence"; tools: Array<{ name: string; args: Record<string, unknown> }> }
  | { type: "provider-add"; name: string; baseURL: string; format: "openai" | "anthropic" | "gemini"; model: string }
  | { type: "key-update"; name: string };

export interface TuiCommandContext {
  config: ForgeConfig;
  messages: ChatMessage[];
  contextFiles: Map<string, string>;
  setWorkspace: (workspace: string) => void;
  persist: () => void;
}

/** Return bounded slash-command completions for the current composer input. */
export function tuiCommandSuggestions(input: string): string[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const prefix = input.slice(1).toLowerCase();
  return slashCommandNames().filter((name) => name.startsWith(prefix)).slice(0, 6).map((name) => `/${name}`);
}

/** Parse a TUI slash command into a typed frontend action without printing output. */
export function executeTuiCommand(input: string, context: TuiCommandContext): TuiCommandResult {
  const parsed = parseSlashCommand(input);
  if (!parsed) return { type: "not-command" };
  const arg = parsed.args.join(" ");
  const config = context.config;
  const profile = config.profiles[config.activeProfile];

  switch (parsed.name) {
    case "exit":
    case "quit": return { type: "exit" };
    case "help": return { type: "overlay", overlay: "help" };
    case "new":
    case "clear": return { type: "clear" };
    case "model": {
      if (!arg || parsed.args[0] === "list") return { type: "overlay", overlay: "models" };
      if (parsed.args[0] === "info") {
        const reference = parsed.args.slice(1).join(" ");
        return reference ? { type: "model-info", reference } : { type: "notice", message: "Usage: /model info <runtime:model-id>" };
      }
      if (parsed.args[0] === "pull") {
        const reference = parsed.args.slice(1).join(" ");
        return reference ? { type: "model-pull", reference } : { type: "notice", message: "Usage: /model pull <runtime:model-id>" };
      }
      const reference = parsed.args[0] === "use" ? parsed.args.slice(1).join(" ") : arg;
      if (!reference) return { type: "notice", message: "Usage: /model use <profile-model-id|runtime:model-id>" };
      if (/^(ollama|lmstudio|llamacpp|openai-compatible):/.test(reference)) activateLocalModel(config, reference);
      else profile.model = reference;
      context.persist();
      return { type: "notice", message: `Using ${reference}.` };
    }
    case "runtime": {
      const operation = parsed.args[0] ?? "list";
      if (!( ["list", "status", "start", "stop"] as string[]).includes(operation)) return { type: "notice", message: "Usage: /runtime list|status|start|stop [kind] [model-path]" };
      return { type: "runtime", operation: operation as "list" | "status" | "start" | "stop", kind: parsed.args[1], modelPath: parsed.args.slice(2).join(" ") || undefined };
    }
    case "mode": {
      if (!arg) return { type: "notice", message: `Permission mode: ${config.permissions.mode}` };
      if (!( ["read-only", "balanced", "autonomous"] as string[]).includes(arg)) return { type: "notice", message: "Usage: /mode read-only|balanced|autonomous" };
      config.permissions.mode = arg as PermissionMode;
      context.persist();
      return { type: "notice", message: `Permission mode set to ${arg}.` };
    }
    case "offline": {
      if (arg !== "on" && arg !== "off") return { type: "notice", message: `Offline mode is ${config.routing.offline ? "on" : "off"}. Usage: /offline on|off` };
      config.routing.offline = arg === "on";
      context.persist();
      return { type: "notice", message: `Offline mode ${arg}.` };
    }
    case "route": {
      if (arg !== "manual" && arg !== "auto") return { type: "notice", message: `Routing is ${config.routing.mode}. Usage: /route manual|auto` };
      config.routing.mode = arg;
      context.persist();
      return { type: "notice", message: `Routing mode set to ${arg}.` };
    }
    case "workspace": {
      if (!arg) return { type: "notice", message: `Workspace: ${config.permissions.workspaceRoot}` };
      try {
        const workspace = fs.realpathSync(arg);
        if (!fs.statSync(workspace).isDirectory()) throw new Error("not a directory");
        context.setWorkspace(workspace);
        return { type: "notice", message: `Workspace set to ${workspace}.` };
      } catch (error) {
        return { type: "notice", message: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    case "context": {
      const sub = parsed.args[0] ?? "list";
      if (sub === "list") return { type: "overlay", overlay: "context" };
      if (sub === "clear") {
        context.contextFiles.clear();
        return { type: "notice", message: "Pinned context cleared." };
      }
      if (sub === "drop") {
        const file = parsed.args.slice(1).join(" ");
        return { type: "notice", message: context.contextFiles.delete(file) ? `Dropped ${file}.` : `${file} was not pinned.` };
      }
      return { type: "overlay", overlay: "context" };
    }
    case "save":
    case "checkpoint": {
      const name = arg || defaultSessionName();
      saveSession(name, context.messages);
      return { type: "notice", message: `Session saved as ${name}.` };
    }
    case "load": {
      if (!arg) return { type: "overlay", overlay: "sessions" };
      try { return { type: "load", messages: loadSession(arg), name: arg }; }
      catch { return { type: "notice", message: `Could not load session ${arg}.` }; }
    }
    case "sessions": return { type: "overlay", overlay: "sessions" };
    case "resume": {
      try { return { type: "load", messages: loadSession("autosave"), name: "autosave" }; }
      catch { return { type: "notice", message: "No automatic recovery session is available." }; }
    }
    case "branch": {
      const name = arg || defaultSessionName();
      try { saveSession(name, context.messages); return { type: "notice", message: `Conversation branched as ${name}.` }; }
      catch (error) { return { type: "notice", message: error instanceof Error ? error.message : String(error) }; }
    }
    case "export": {
      if (!arg || !/\.(md|json)$/i.test(arg)) return { type: "notice", message: "Usage: /export <file.md|file.json>" };
      const extension = arg.toLowerCase().endsWith(".json") ? ".json" : ".md";
      return { type: "tool", name: "write_file", args: { path: arg, content: serializeConversation(context.messages, extension) } };
    }
    case "history": return { type: "notice", message: `${context.messages.filter((message) => message.role !== "system").length} conversation messages are available in scrollback.` };
    case "instructions": {
      const items = loadProjectInstructions(config.permissions.workspaceRoot);
      return { type: "notice", message: items.length ? items.map((item) => `${item.file} (${item.content.length} chars)`).join(" · ") : "No FORGE.md or AGENTS.md found." };
    }
    case "index": {
      const project = detectProject(config.permissions.workspaceRoot);
      return { type: "notice", message: `Languages: ${project.languages.join(", ") || "unknown"} · package manager: ${project.packageManager ?? "none"} · Git: ${project.git ? "yes" : "no"} · scripts: ${project.scripts.join(", ") || "none"}` };
    }
    case "tree": return { type: "tool", name: "file_tree", args: { pattern: arg || "**/*" } };
    case "read": {
      if (!parsed.args[0]) return { type: "notice", message: "Usage: /read <file> [start:end]" };
      const range = parsed.args[1]?.match(/^(\d+):(\d+)$/);
      if (parsed.args[1] && !range) return { type: "notice", message: "Line range must use start:end, for example 10:40." };
      return { type: "tool", name: "read_file", args: { path: parsed.args[0], startLine: range ? Number(range[1]) : undefined, endLine: range ? Number(range[2]) : undefined } };
    }
    case "open": {
      if (!arg) return { type: "notice", message: "Usage: /open <file>" };
      try {
        const full = resolveWorkspacePath(config.permissions.workspaceRoot, arg);
        context.contextFiles.set(arg, fs.readFileSync(full, "utf-8").slice(0, 48_000));
        return { type: "notice", message: `Pinned ${arg}.` };
      } catch (error) { return { type: "notice", message: `Could not pin file: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    case "search": return parsed.args[0] ? { type: "tool", name: "grep_search", args: { pattern: parsed.args[0], glob: parsed.args[1] ?? "**/*" } } : { type: "notice", message: "Usage: /search <regex> [glob]" };
    case "files": return { type: "tool", name: "glob_search", args: { pattern: arg || "**/*" } };
    case "inspect": return arg ? { type: "tool", name: "file_info", args: { path: arg } } : { type: "notice", message: "Usage: /inspect <path>" };
    case "hash": return arg ? { type: "tool", name: "hash_file", args: { path: arg } } : { type: "notice", message: "Usage: /hash <file>" };
    case "json": return parsed.args[0] ? { type: "tool", name: "json_query", args: { path: parsed.args[0], pointer: parsed.args[1] ?? "" } } : { type: "notice", message: "Usage: /json <file> [pointer]" };
    case "stats": return { type: "tool", name: "workspace_stats", args: { pattern: arg || "**/*" } };
    case "diff": return { type: "tool", name: "git_diff", args: { args: parsed.args } };
    case "changed": return { type: "tool", name: "git_status", args: { args: ["--short"] } };
    case "git": {
      const sub = parsed.args[0] ?? "status";
      if (!( ["status", "diff", "log"] as string[]).includes(sub)) return { type: "notice", message: "Usage: /git status|diff|log" };
      return { type: "tool", name: `git_${sub}`, args: { args: parsed.args.slice(1) } };
    }
    case "show": return parsed.args[0] ? { type: "tool", name: "git_show", args: { args: parsed.args[1] ? [parsed.args[0], "--", parsed.args[1]] : [parsed.args[0]] } } : { type: "notice", message: "Usage: /show <revision> [path]" };
    case "test":
    case "build": {
      const project = detectProject(config.permissions.workspaceRoot);
      const script = parsed.name === "build" ? "build" : (parsed.args[0] || "test");
      if (!project.scripts.includes(script)) return { type: "notice", message: `No npm script named ${script} was detected.` };
      return { type: "tool", name: "run_command", args: { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script] } };
    }
    case "lint":
    case "format":
    case "typecheck": {
      const project = detectProject(config.permissions.workspaceRoot);
      const candidates = parsed.name === "lint" ? ["lint"] : parsed.name === "format" ? ["format", "fmt"] : ["typecheck", "check:types"];
      const requested = parsed.args[0];
      const script = requested ? (project.scripts.includes(requested) ? requested : undefined) : candidates.find((item) => project.scripts.includes(item));
      if (!script) return { type: "notice", message: requested ? `No npm script named ${requested} was detected.` : `No ${parsed.name} npm script was detected.` };
      return { type: "tool", name: "run_command", args: { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script] } };
    }
    case "check": {
      const project = detectProject(config.permissions.workspaceRoot);
      const scripts = ["typecheck", "lint", "test", "build"].filter((script) => project.scripts.includes(script));
      return scripts.length ? { type: "tool-sequence", tools: scripts.map((script) => ({ name: "run_command", args: { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script] } })) } : { type: "notice", message: "No typecheck, lint, test, or build npm scripts were detected." };
    }
    case "run": return parsed.args[0] ? { type: "tool", name: "run_command", args: { command: parsed.args[0], args: parsed.args.slice(1) } } : { type: "notice", message: "Usage: /run <program> [args...]" };
    case "mkdir": return parsed.args[0] ? { type: "tool", name: "make_directory", args: { path: parsed.args[0] } } : { type: "notice", message: "Usage: /mkdir <directory>" };
    case "copy": return parsed.args.length === 2 ? { type: "tool", name: "copy_file", args: { source: parsed.args[0], destination: parsed.args[1] } } : { type: "notice", message: "Usage: /copy <source> <destination>" };
    case "tools": return { type: "notice", message: createTools({ workspaceRoot: config.permissions.workspaceRoot }).map((tool) => `${tool.def.name} [${tool.risk}]`).join(" · ") };
    case "doctor": return { type: "runtime", operation: "status" };
    case "review": return { type: "prompt", prompt: `Review the current workspace changes${arg ? ` with focus on ${arg}` : ""}. Inspect the Git diff and report correctness, security, and test findings by severity.` };
    case "plan": return arg ? { type: "prompt", prompt: `Create a decision-complete implementation plan for this workspace goal: ${arg}` } : { type: "notice", message: "Usage: /plan <goal>" };
    case "fix": return arg ? { type: "prompt", prompt: `Diagnose and fix this workspace problem, using tools and tests as needed: ${arg}` } : { type: "notice", message: "Usage: /fix <problem>" };
    case "explain": return { type: "prompt", prompt: `Explain ${arg || "the current workspace architecture"} clearly. Inspect the relevant code first and cite concrete files and symbols.` };
    case "refactor": return arg ? { type: "prompt", prompt: `Refactor ${arg}. Preserve behavior, keep the change focused, and verify it with relevant tests.` } : { type: "notice", message: "Usage: /refactor <target>" };
    case "testgen": return arg ? { type: "prompt", prompt: `Create meaningful tests for ${arg}. Cover success, edge, and failure paths, then run them.` } : { type: "notice", message: "Usage: /testgen <target>" };
    case "docs": return arg ? { type: "prompt", prompt: `Create or improve documentation for ${arg}. Keep it accurate, practical, and consistent with the codebase.` } : { type: "notice", message: "Usage: /docs <target>" };
    case "security": return { type: "prompt", prompt: `Audit ${arg || "the current workspace changes"} for security weaknesses. Inspect the code, rank findings by severity, and provide actionable fixes.` };
    case "summarize": return { type: "prompt", prompt: "Summarize the current work: goal, relevant changes, Git state, verification completed, remaining risks, and recommended next action." };
    case "theme": {
      config.ui.theme = config.ui.theme === "flame" ? "cool" : config.ui.theme === "cool" ? "contrast" : config.ui.theme === "contrast" ? "mono" : "flame";
      context.persist();
      return { type: "notice", message: `Theme set to ${config.ui.theme}.` };
    }
    case "mouse": {
      if (arg !== "on" && arg !== "off") return { type: "notice", message: `Mouse controls are ${config.ui.mouse ? "on" : "off"}. Usage: /mouse on|off` };
      config.ui.mouse = arg === "on";
      context.persist();
      return { type: "notice", message: `Mouse controls ${arg}.` };
    }
    case "cost":
    case "status": return { type: "notice", message: "Current usage and limits are always visible in the bottom status line." };
    case "limit": {
      const sub = parsed.args[0] ?? "show";
      if (sub === "show") {
        const limit = profile.subscription;
        return { type: "notice", message: limit ? `Plan ${limit.name ?? "configured"} · ${limit.tokenLimit?.toLocaleString("en-US") ?? "no token ceiling"} · ${limit.costLimitUsd != null ? `$${limit.costLimitUsd}` : "no cost ceiling"}` : "No configured subscription limit; provider rate limits still appear automatically." };
      }
      if (sub === "clear") { delete profile.subscription; context.persist(); return { type: "notice", message: "Subscription limit cleared." }; }
      if (sub === "set") {
        const tokenLimit = Number(parsed.args[1]);
        const costLimitUsd = parsed.args[2] ? Number(parsed.args[2]) : undefined;
        const name = parsed.args.slice(3).join(" ") || undefined;
        if (!Number.isInteger(tokenLimit) || tokenLimit <= 0 || (costLimitUsd != null && (!Number.isFinite(costLimitUsd) || costLimitUsd <= 0))) return { type: "notice", message: "Usage: /limit set <token-limit> [cost-limit-usd] [plan-name]" };
        profile.subscription = { tokenLimit, costLimitUsd, name };
        context.persist();
        return { type: "notice", message: "Subscription limit configured." };
      }
      return { type: "notice", message: "Usage: /limit show|set|clear" };
    }
    case "usage": {
      if (parsed.args[0] === "reset") {
        clearProfileUsage(config.activeProfile);
        return { type: "notice", message: "Local usage counter reset. Provider billing data is unchanged." };
      }
      if (parsed.args[0]) return { type: "notice", message: "Usage: /usage [reset]" };
      const entry = loadUsageLedger().profiles[config.activeProfile];
      return { type: "notice", message: entry ? `Recorded usage: ${(entry.promptTokens + entry.completionTokens).toLocaleString("en-US")} tokens (${entry.promptTokens.toLocaleString("en-US")} input, ${entry.completionTokens.toLocaleString("en-US")} output).` : `No recorded usage for ${config.activeProfile}.` };
    }
    case "provider": {
      const sub = parsed.args[0] ?? "list";
      if (sub === "list") return { type: "notice", message: Object.entries(config.profiles).map(([name, item]) => `${name === config.activeProfile ? "*" : " "} ${name}: ${item.model} (${item.kind})`).join(" · ") };
      if (sub === "use") {
        const name = parsed.args[1];
        if (!name || !config.profiles[name]) return { type: "notice", message: "Usage: /provider use <configured-profile>" };
        config.activeProfile = name; context.persist(); return { type: "notice", message: `Using provider ${name}.` };
      }
      if (sub === "add") {
        const [name, baseURL, formatArg, ...rest] = parsed.args.slice(1);
        const knownFormats = ["openai", "anthropic", "gemini"] as const;
        const formatGiven = knownFormats.includes((formatArg ?? "").toLowerCase() as (typeof knownFormats)[number]);
        const format = (formatGiven ? formatArg!.toLowerCase() : "openai") as "openai" | "anthropic" | "gemini";
        const model = (formatGiven ? rest : [formatArg, ...rest].filter(Boolean)).join(" ");
        if (!name || !baseURL || !model) return { type: "notice", message: "Usage: /provider add <name> <base-url> [openai|anthropic|gemini] <default-model>" };
        if (!/^https?:\/\//i.test(baseURL)) return { type: "notice", message: "Base URL must start with http:// or https://." };
        return { type: "provider-add", name, baseURL, format, model };
      }
      return { type: "notice", message: "Usage: /provider list | use <name> | add <name> <base-url> [format] <model>" };
    }
    case "key": {
      const name = parsed.args[0];
      if (!name) return { type: "notice", message: "Usage: /key <profile> — you'll be prompted to type the key without it appearing in the composer." };
      if (!config.profiles[name]) return { type: "notice", message: `Unknown profile "${name}". Use /provider list.` };
      if (parsed.args.length > 1) return { type: "notice", message: "/key <profile> <key> is disabled — the key would land in scrollback and shell history. Run /key <profile> to enter it masked instead." };
      return { type: "key-update", name };
    }
    default: return { type: "notice", message: `Unknown command /${parsed.name}. Run /help for a list.` };
  }
}
