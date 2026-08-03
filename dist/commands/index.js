import fs from "node:fs";
import ora from "ora";
import { colors, printError, printOk, printSystem, printWarn, divider } from "../ui.js";
import { createTools } from "../tools/index.js";
import { listSessions, saveSession, loadSession, defaultSessionName } from "../session.js";
import { fetchModels } from "../providers/models.js";
import { activateLocalModel, inspectLocalModel, listRuntimeSummaries, pullLocalModel } from "../runtime/service.js";
import { startRuntime, stopOwnedRuntime } from "../runtime/process.js";
import { detectProject } from "../project.js";
import { parseSlashCommand } from "./parser.js";
import { SLASH_COMMANDS } from "./registry.js";
export async function handleCommand(input, state) {
    const parsed = parseSlashCommand(input);
    if (!parsed)
        return "not-a-command";
    const cmd = parsed.name;
    const rest = parsed.args;
    const arg = rest.join(" ");
    switch (cmd) {
        case "help": {
            console.log(colors.accent("\nSlash commands:"));
            for (const definition of SLASH_COMMANDS) {
                console.log(`  ${definition.usage.padEnd(42)} ${definition.description}`);
            }
            console.log();
            return "handled";
        }
        case "exit":
        case "quit": {
            return "exit";
        }
        case "provider": {
            const [sub, ...subrest] = rest;
            if (sub === "list") {
                for (const [name, p] of Object.entries(state.cfg.profiles)) {
                    const active = name === state.cfg.activeProfile ? colors.ok(" (active)") : "";
                    console.log(`  ${colors.accent(name)} — ${p.format} — ${p.baseURL} — model: ${p.model}${active}`);
                }
                return "handled";
            }
            if (sub === "use") {
                const name = subrest[0];
                if (!name || !state.cfg.profiles[name]) {
                    printError(`Unknown profile "${name}". Use /provider list.`);
                    return "handled";
                }
                state.setActiveProfile(name);
                printOk(`Switched to provider "${name}" (model: ${state.cfg.profiles[name].model})`);
                return "handled";
            }
            if (sub === "add") {
                await state.addProviderInteractive();
                return "handled";
            }
            printWarn("Usage: /provider list | use <name> | add");
            return "handled";
        }
        case "model": {
            const profile = state.cfg.profiles[state.cfg.activeProfile];
            if (rest[0] === "list") {
                console.log(colors.accent("\nRemote profiles:"));
                for (const [name, item] of Object.entries(state.cfg.profiles)) {
                    console.log(`  ${name === state.cfg.activeProfile ? "*" : " "} ${name} — ${item.model}`);
                }
                console.log(colors.accent("\nLocal runtimes:"));
                for (const runtime of await listRuntimeSummaries(state.cfg)) {
                    const status = runtime.health.healthy ? colors.ok("online") : colors.dim("offline");
                    console.log(`  ${runtime.kind} — ${status}`);
                    for (const model of runtime.models)
                        console.log(`    ${runtime.kind}:${model.id}`);
                }
                console.log();
                return "handled";
            }
            if (rest[0] === "use") {
                const reference = rest.slice(1).join(" ");
                if (!reference) {
                    printWarn("Usage: /model use <profile-model-id|runtime:model-id>");
                    return "handled";
                }
                if (/^(ollama|lmstudio|llamacpp|openai-compatible):/.test(reference)) {
                    const profileName = activateLocalModel(state.cfg, reference);
                    state.persistConfig();
                    printOk(`Using ${reference} through profile "${profileName}".`);
                }
                else {
                    profile.model = reference;
                    state.persistConfig();
                    printOk(`Model set to "${reference}" for profile "${state.cfg.activeProfile}".`);
                }
                return "handled";
            }
            if (rest[0] === "info") {
                const reference = rest.slice(1).join(" ");
                if (!reference || !/^(ollama|lmstudio|llamacpp|openai-compatible):/.test(reference)) {
                    printWarn("Usage: /model info <runtime:model-id>");
                    return "handled";
                }
                const capabilities = await inspectLocalModel(state.cfg, reference);
                printSystem(`${reference} — ${Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name).join(", ")}`);
                return "handled";
            }
            if (rest[0] === "pull") {
                const reference = rest.slice(1).join(" ");
                if (!reference) {
                    printWarn("Usage: /model pull <runtime:model-id>");
                    return "handled";
                }
                if (!(await state.confirm(`Download ${reference}? Large models may use significant disk space.`))) {
                    printWarn("Download cancelled.");
                    return "handled";
                }
                try {
                    for await (const progress of pullLocalModel(state.cfg, reference)) {
                        const percent = progress.total && progress.completed ? ` ${Math.floor((progress.completed / progress.total) * 100)}%` : "";
                        process.stderr.write(`\r${progress.status}${percent}`);
                    }
                    process.stderr.write("\n");
                    printOk(`Downloaded ${reference}.`);
                }
                catch (error) {
                    process.stderr.write("\n");
                    printError(error.message);
                }
                return "handled";
            }
            if (arg && !["list", "use", "info", "pull", "remove", "unload"].includes(rest[0] ?? "")) {
                profile.model = arg;
                state.persistConfig();
                printOk(`Model set to "${arg}" for profile "${state.cfg.activeProfile}".`);
                return "handled";
            }
            printSystem(`Current model: ${profile.model}`);
            const spinner = ora("Fetching available models…").start();
            let models = [];
            try {
                models = await fetchModels(profile);
                spinner.stop();
            }
            catch (err) {
                spinner.fail(`Could not fetch model list: ${err.message}`);
                printSystem("Use /model <name> to set one directly instead.");
                return "handled";
            }
            if (models.length === 0) {
                printWarn("This provider doesn't expose a model list. Use /model <name> to set one directly.");
                return "handled";
            }
            for (const m of models)
                state.pricingCache.set(`${state.cfg.activeProfile}:${m.id}`, m);
            models.forEach((m, i) => {
                const marker = m.id === profile.model ? colors.ok(" (current)") : "";
                const price = m.inputPricePerMillion != null
                    ? colors.dim(` — $${m.inputPricePerMillion}/$${m.outputPricePerMillion} per M tokens in/out`)
                    : "";
                console.log(`  ${colors.accent(String(i + 1).padStart(3))}. ${m.id}${price}${marker}`);
            });
            const choice = await state.ask(colors.user("Pick a number (or type a model id, blank to cancel): "));
            if (!choice) {
                printSystem("Cancelled.");
                return "handled";
            }
            const idx = parseInt(choice, 10);
            const selected = !isNaN(idx) && models[idx - 1] ? models[idx - 1] : models.find((m) => m.id === choice) ?? { id: choice };
            profile.model = selected.id;
            state.persistConfig();
            printOk(`Model set to "${selected.id}".`);
            return "handled";
        }
        case "key": {
            const [profileName, ...keyParts] = rest;
            const key = keyParts.join(" ");
            if (!profileName || !key) {
                printWarn("Usage: /key <profile> <newApiKey>");
                return "handled";
            }
            if (!state.cfg.profiles[profileName]) {
                printError(`Unknown profile "${profileName}".`);
                return "handled";
            }
            state.cfg.profiles[profileName].apiKey = key;
            state.persistConfig();
            printWarn("/key is deprecated because it exposes secrets in terminal history; a masked credential flow is planned.");
            printOk(`API key updated for "${profileName}".`);
            return "handled";
        }
        case "runtime": {
            const sub = rest[0] ?? "list";
            if (sub === "list" || sub === "status") {
                for (const runtime of await listRuntimeSummaries(state.cfg)) {
                    const stateLabel = runtime.health.healthy ? colors.ok("online") : colors.warn(`offline${runtime.health.message ? ` — ${runtime.health.message}` : ""}`);
                    console.log(`  ${colors.accent(runtime.kind)} — ${stateLabel} — ${runtime.models.length} model(s)`);
                }
                return "handled";
            }
            const kind = rest[1];
            if (!kind || !["ollama", "lmstudio", "llamacpp", "openai-compatible"].includes(kind)) {
                printWarn("Usage: /runtime start|stop <ollama|lmstudio|llamacpp> [model-path]");
                return "handled";
            }
            if (sub === "start") {
                if (!(await state.confirm(`Start ${kind} locally?`)))
                    return "handled";
                try {
                    const result = await startRuntime(state.cfg, kind, { modelPath: rest.slice(2).join(" ") || undefined });
                    printOk(result.owned ? `Started ${kind} (PID ${result.pid}).` : `${kind} is already online.`);
                }
                catch (error) {
                    printError(error.message);
                }
                return "handled";
            }
            if (sub === "stop") {
                if (!(await state.confirm(`Stop the ${kind} process previously started by Forge?`)))
                    return "handled";
                try {
                    await stopOwnedRuntime(state.cfg, kind);
                    printOk(`Stopped ${kind}.`);
                }
                catch (error) {
                    printError(error.message);
                }
                return "handled";
            }
            printWarn("Usage: /runtime list|status|start|stop");
            return "handled";
        }
        case "mode": {
            const mode = rest[0];
            if (!mode) {
                printSystem(`Permission mode: ${state.cfg.permissions.mode}`);
                return "handled";
            }
            if (!["read-only", "balanced", "autonomous"].includes(mode)) {
                printWarn("Usage: /mode read-only|balanced|autonomous");
                return "handled";
            }
            state.cfg.permissions.mode = mode;
            state.persistConfig();
            printOk(`Permission mode set to ${mode}.`);
            return "handled";
        }
        case "route": {
            const mode = rest[0];
            if (!mode) {
                printSystem(`Routing mode: ${state.cfg.routing.mode}; offline: ${state.cfg.routing.offline}`);
                return "handled";
            }
            if (mode !== "manual" && mode !== "auto") {
                printWarn("Usage: /route manual|auto");
                return "handled";
            }
            state.cfg.routing.mode = mode;
            state.persistConfig();
            printOk(`Routing mode set to ${mode}.`);
            return "handled";
        }
        case "offline": {
            const value = rest[0];
            if (!value) {
                printSystem(`Offline mode: ${state.cfg.routing.offline ? "on" : "off"}`);
                return "handled";
            }
            if (value !== "on" && value !== "off") {
                printWarn("Usage: /offline on|off");
                return "handled";
            }
            state.cfg.routing.offline = value === "on";
            state.persistConfig();
            printOk(`Offline mode ${value}.`);
            return "handled";
        }
        case "workspace": {
            if (!arg) {
                printSystem(`Workspace: ${state.cfg.permissions.workspaceRoot}`);
                return "handled";
            }
            try {
                const workspace = fs.realpathSync(arg);
                if (!fs.statSync(workspace).isDirectory())
                    throw new Error("not a directory");
                state.setWorkspace(workspace);
                printOk(`Workspace set to ${workspace}.`);
            }
            catch (error) {
                printError(`Invalid workspace: ${error.message}`);
            }
            return "handled";
        }
        case "instructions": {
            if (!state.projectInstructions.length)
                printSystem("No FORGE.md or AGENTS.md found in the workspace root.");
            else
                state.projectInstructions.forEach((item) => console.log(`  ${item.file} (${item.content.length} chars)`));
            return "handled";
        }
        case "tree": {
            const tool = createTools({ workspaceRoot: state.cfg.permissions.workspaceRoot }).find((item) => item.def.name === "file_tree");
            console.log(await tool.execute({ pattern: arg || "**/*" }));
            return "handled";
        }
        case "index": {
            const info = detectProject(state.cfg.permissions.workspaceRoot);
            printSystem(`Languages: ${info.languages.join(", ") || "unknown"}`);
            printSystem(`Package manager: ${info.packageManager ?? "none"}; Git: ${info.git ? "yes" : "no"}`);
            printSystem(`Scripts: ${info.scripts.join(", ") || "none"}`);
            return "handled";
        }
        case "context": {
            const sub = rest[0] ?? "list";
            if (sub === "list") {
                if (!state.contextFiles.size)
                    printSystem("No pinned context files.");
                else
                    state.contextFiles.forEach((content, file) => console.log(`  ${file} (${content.length} chars)`));
            }
            else if (sub === "add") {
                try {
                    printOk(`Pinned ${state.pinContext(rest.slice(1).join(" "))}.`);
                }
                catch (error) {
                    printError(error.message);
                }
            }
            else if (sub === "drop") {
                const file = rest.slice(1).join(" ");
                printSystem(state.contextFiles.delete(file) ? `Dropped ${file}.` : `${file} was not pinned.`);
            }
            else if (sub === "clear") {
                state.contextFiles.clear();
                printOk("Pinned context cleared.");
            }
            else
                printWarn("Usage: /context list|add|drop|clear");
            return "handled";
        }
        case "diff":
        case "git": {
            const sub = cmd === "diff" ? "diff" : (rest[0] ?? "status");
            if (!["status", "diff", "log"].includes(sub)) {
                printWarn("Usage: /git status|diff|log");
                return "handled";
            }
            const tool = createTools({ workspaceRoot: state.cfg.permissions.workspaceRoot }).find((item) => item.def.name === `git_${sub}`);
            try {
                console.log(await tool.execute({ args: cmd === "git" ? rest.slice(1) : rest }));
            }
            catch (error) {
                printError(error.message);
            }
            return "handled";
        }
        case "test":
        case "build": {
            const project = detectProject(state.cfg.permissions.workspaceRoot);
            const script = cmd === "build" ? "build" : (rest[0] || "test");
            if (!project.scripts.includes(script)) {
                printError(`No npm script named "${script}" was detected.`);
                return "handled";
            }
            if (!(await state.confirm(`Run npm ${script} in ${state.cfg.permissions.workspaceRoot}?`)))
                return "handled";
            const tool = createTools({ workspaceRoot: state.cfg.permissions.workspaceRoot }).find((item) => item.def.name === "run_command");
            try {
                console.log(await tool.execute({ command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script] }));
            }
            catch (error) {
                printError(error.message);
            }
            return "handled";
        }
        case "review": {
            state.pendingPrompt = `Review the current workspace changes${arg ? ` with focus on ${arg}` : ""}. Inspect the Git diff, identify correctness, security, and test issues, and report findings by severity.`;
            return "handled";
        }
        case "plan": {
            if (!arg) {
                printWarn("Usage: /plan <goal>");
                return "handled";
            }
            state.pendingPrompt = `Create a decision-complete implementation plan for this workspace goal: ${arg}`;
            return "handled";
        }
        case "fix": {
            if (!arg) {
                printWarn("Usage: /fix <problem>");
                return "handled";
            }
            state.pendingPrompt = `Diagnose and fix this workspace problem, using tools and tests as needed: ${arg}`;
            return "handled";
        }
        case "tools": {
            console.log(colors.accent("\nAvailable agent tools:"));
            for (const tool of createTools({ workspaceRoot: state.cfg.permissions.workspaceRoot })) {
                console.log(`  ${colors.tool(tool.def.name)} [${tool.risk}] — ${tool.def.description}`);
            }
            console.log();
            return "handled";
        }
        case "status": {
            printSystem(`Profile: ${state.cfg.activeProfile}; model: ${state.cfg.profiles[state.cfg.activeProfile].model}`);
            printSystem(`Workspace: ${state.cfg.permissions.workspaceRoot}`);
            printSystem(`Permissions: ${state.cfg.permissions.mode}; routing: ${state.cfg.routing.mode}; offline: ${state.cfg.routing.offline}`);
            return "handled";
        }
        case "doctor": {
            const active = state.cfg.profiles[state.cfg.activeProfile];
            printSystem(`Config schema: v${state.cfg.schemaVersion}`);
            printSystem(`Active profile: ${active ? "ok" : "missing"}`);
            printSystem(`Workspace: ${fs.existsSync(state.cfg.permissions.workspaceRoot) ? "ok" : "missing"}`);
            for (const runtime of await listRuntimeSummaries(state.cfg)) {
                printSystem(`${runtime.kind}: ${runtime.health.healthy ? "online" : "offline"}`);
            }
            return "handled";
        }
        case "new":
        case "clear": {
            state.resetMessages();
            printOk("Conversation cleared.");
            return "handled";
        }
        case "history": {
            divider();
            for (const m of state.messages) {
                if (m.role === "system")
                    continue;
                console.log(colors.dim(`[${m.role}]`), m.content?.slice(0, 500));
            }
            divider();
            return "handled";
        }
        case "checkpoint":
        case "save": {
            const name = arg || defaultSessionName();
            saveSession(name, state.messages);
            printOk(`Session saved as "${name}".`);
            return "handled";
        }
        case "load": {
            if (!arg) {
                printWarn("Usage: /load <name>");
                return "handled";
            }
            try {
                state.messages = loadSession(arg);
                printOk(`Loaded session "${arg}" (${state.messages.length} messages).`);
            }
            catch {
                printError(`Could not load session "${arg}".`);
            }
            return "handled";
        }
        case "sessions": {
            const names = listSessions();
            if (!names.length)
                printSystem("No saved sessions yet.");
            else
                names.forEach((n) => console.log("  " + n));
            return "handled";
        }
        case "cost": {
            const profile = state.cfg.profiles[state.cfg.activeProfile];
            const pricing = state.pricingCache.get(`${state.cfg.activeProfile}:${profile.model}`);
            let costLine = "";
            if (pricing && (pricing.inputPricePerMillion || pricing.outputPricePerMillion)) {
                const cost = (state.usage.promptTokens / 1_000_000) * (pricing.inputPricePerMillion ?? 0) +
                    (state.usage.completionTokens / 1_000_000) * (pricing.outputPricePerMillion ?? 0);
                costLine = ` — est. cost: $${cost.toFixed(4)}`;
            }
            printSystem(`Cumulative usage — prompt tokens: ${state.usage.promptTokens}, completion tokens: ${state.usage.completionTokens}${costLine}`);
            return "handled";
        }
        case "theme": {
            state.cfg.ui.theme = state.cfg.ui.theme === "flame" ? "cool" : "flame";
            state.persistConfig();
            printOk(`Theme set to ${state.cfg.ui.theme}.`);
            return "handled";
        }
        case "ui": {
            const mode = rest[0];
            if (mode !== "inline" && mode !== "tui") {
                printSystem(`UI mode: ${state.cfg.ui.mode}. Usage: /ui inline|tui`);
                return "handled";
            }
            state.cfg.ui.mode = mode;
            state.persistConfig();
            printOk(`UI preference set to ${mode}; it will apply on the next launch.`);
            return "handled";
        }
        default:
            printWarn(`Unknown command: /${cmd}. Type /help for a list.`);
            return "handled";
    }
}
