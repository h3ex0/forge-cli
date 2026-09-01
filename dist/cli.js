import fs from "node:fs";
import { Command } from "commander";
import { printError, printOk, printSystem } from "./ui.js";
import { configExists, DEFAULT_CONFIG, loadConfig, readMaskedLine, runSetupWizard, saveConfig } from "./config.js";
import { createDriver } from "./providers/index.js";
import { activateLocalModel, inspectLocalModel, listRuntimeSummaries, pullLocalModel } from "./runtime/service.js";
import { startRuntime, stopOwnedRuntime } from "./runtime/process.js";
import { listSessions, loadSession } from "./session.js";
import { VERSION } from "./version.js";
import { clearProfileUsage, loadUsageLedger } from "./usage-store.js";
import { deleteProfileSecret } from "./security/secrets.js";
function requireConfig() {
    if (!configExists())
        throw new Error("Forge is not configured. Run `forge chat` once to start setup.");
    return loadConfig();
}
async function interactiveConfig() {
    return configExists() ? loadConfig() : runSetupWizard();
}
/** Decide whether the terminal can host Forge's full-screen interface. */
export function shouldLaunchTui(terminal) {
    return terminal.inputIsTTY === true
        && terminal.outputIsTTY === true
        && (terminal.columns ?? 80) >= 72
        && (terminal.rows ?? 24) >= 18;
}
async function startInteractive() {
    const config = await interactiveConfig();
    if (!config.activeProfile || !config.profiles[config.activeProfile])
        throw new Error("No active profile. Use `forge model use` or add a provider.");
    if (!shouldLaunchTui({ inputIsTTY: process.stdin.isTTY, outputIsTTY: process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows })) {
        throw new Error("Forge's interactive workspace needs a real terminal at least 72x18. Resize your terminal, or use `forge run \"<prompt>\"` for non-interactive use.");
    }
    const tui = await import("./tui.js");
    registerTuiModule(tui);
    await tui.startTui(config);
}
async function runPrompt(prompt, options) {
    const config = requireConfig();
    if (options.model) {
        if (/^(ollama|lmstudio|llamacpp|openai-compatible):/.test(options.model))
            activateLocalModel(config, options.model);
        else
            config.profiles[config.activeProfile].model = options.model;
    }
    const profile = config.profiles[config.activeProfile];
    if ((options.offline || config.routing.offline) && profile.kind !== "local")
        throw new Error("Offline mode requires a local model profile.");
    const chunks = [];
    let usage;
    let failure;
    await createDriver(profile).streamChat([
        { role: "system", content: "You are Forge, a concise AI coding assistant." },
        { role: "user", content: prompt },
    ], [], profile.model, {
        onTextDelta(delta) {
            chunks.push(delta);
            if (!options.json)
                process.stdout.write(delta);
        },
        onToolCallsComplete() { },
        onDone(value) { usage = value; },
        onError(error) { failure = error; },
    });
    if (failure)
        throw failure;
    if (options.json)
        console.log(JSON.stringify({ model: profile.model, profile: config.activeProfile, content: chunks.join(""), usage }));
    else
        process.stdout.write("\n");
}
function printRuntimeSummaries(summaries, json) {
    if (json) {
        console.log(JSON.stringify(summaries));
        return;
    }
    for (const runtime of summaries) {
        console.log(`${runtime.kind.padEnd(18)} ${runtime.health.healthy ? "online " : "offline"} ${runtime.models.length} model(s)`);
        for (const model of runtime.models)
            console.log(`  ${runtime.kind}:${model.id}`);
    }
}
function addCompletionCommand(program) {
    program.command("completion <shell>").description("Generate shell completion setup").action((shell) => {
        const scripts = {
            powershell: "Register-ArgumentCompleter -Native -CommandName forge -ScriptBlock { param($wordToComplete) 'chat','tui','run','model','provider','key','runtime','session','limit','doctor','completion' | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_,$_, 'ParameterValue', $_) } }",
            bash: "complete -W 'chat tui run model provider key runtime session limit doctor completion' forge",
            zsh: "compdef '_arguments \"1:command:(chat tui run model provider key runtime session limit doctor completion)\"' forge",
            fish: "complete -c forge -f -a 'chat tui run model provider key runtime session limit doctor completion'",
        };
        const script = scripts[shell];
        if (!script)
            throw new Error("Shell must be powershell, bash, zsh, or fish.");
        console.log(script);
    });
}
export function createProgram() {
    const program = new Command();
    program.name("forge").description("Local-first, multi-provider AI coding agent").version(VERSION).showHelpAfterError();
    program.action(startInteractive);
    program.command("chat").description("Open Forge's full-screen terminal workspace").action(startInteractive);
    program.command("tui").description("Open Forge's full-screen terminal workspace").action(startInteractive);
    program.command("run <prompt...>").description("Run one non-interactive prompt")
        .option("--model <reference>", "Profile model id or runtime:model reference")
        .option("--offline", "Require local execution")
        .option("--json", "Emit machine-readable JSON")
        .action(async (parts, options) => runPrompt(parts.join(" "), options));
    const model = program.command("model").description("Manage cloud and local models");
    model.command("list").option("--json").action(async (options) => printRuntimeSummaries(await listRuntimeSummaries(requireConfig()), Boolean(options.json)));
    model.command("use <reference>").description("Activate runtime:model or set the active profile model").action((reference) => {
        const config = requireConfig();
        if (/^(ollama|lmstudio|llamacpp|openai-compatible):/.test(reference))
            activateLocalModel(config, reference);
        else
            config.profiles[config.activeProfile].model = reference;
        saveConfig(config);
        printOk(`Using ${reference}.`);
    });
    model.command("info <reference>").option("--json").action(async (reference, options) => {
        const capabilities = await inspectLocalModel(requireConfig(), reference);
        console.log(options.json ? JSON.stringify(capabilities) : `${reference}: ${Object.entries(capabilities).filter(([, value]) => value === true).map(([name]) => name).join(", ")}`);
    });
    model.command("pull <reference>").option("-y, --yes", "Confirm the potentially large download").action(async (reference, options) => {
        if (!options.yes)
            throw new Error("Model downloads require explicit confirmation. Re-run with --yes after checking model size and license.");
        for await (const progress of pullLocalModel(requireConfig(), reference)) {
            const percent = progress.total && progress.completed ? ` ${Math.floor((progress.completed / progress.total) * 100)}%` : "";
            process.stderr.write(`\r${progress.status}${percent}`);
        }
        process.stderr.write("\n");
        printOk(`Downloaded ${reference}.`);
    });
    const provider = program.command("provider").description("Manage remote provider profiles");
    provider.command("list").option("--json").action((options) => {
        const config = requireConfig();
        const rows = Object.entries(config.profiles).map(([name, item]) => ({ name, active: name === config.activeProfile, model: item.model, kind: item.kind }));
        if (options.json)
            console.log(JSON.stringify(rows));
        else if (!rows.length)
            console.log("No providers configured. Run `forge provider add`.");
        else
            for (const row of rows)
                console.log(`${row.active ? "*" : " "} ${row.name}: ${row.model} (${row.kind})`);
    });
    provider.command("use <name>").action((name) => {
        const config = requireConfig();
        if (!config.profiles[name])
            throw new Error(`Unknown profile "${name}". Run \`forge provider list\`.`);
        config.activeProfile = name;
        saveConfig(config);
        printOk(`Using provider ${name}.`);
    });
    provider.command("add <name> <base-url> <model>")
        .description("Add a remote provider profile")
        .option("--format <format>", "openai, anthropic, or gemini", "openai")
        .option("--key <key>", "API key (omit to enter it hidden)")
        .action(async (name, baseURL, model, options) => {
        if (!/^https?:\/\//i.test(baseURL))
            throw new Error("Base URL must start with http:// or https://.");
        const knownFormats = ["openai", "anthropic", "gemini"];
        if (!knownFormats.includes(options.format))
            throw new Error("--format must be openai, anthropic, or gemini.");
        const config = configExists() ? loadConfig() : structuredClone(DEFAULT_CONFIG);
        if (config.profiles[name])
            throw new Error(`Profile "${name}" already exists. Use \`forge key set ${name}\` to change its key.`);
        const key = options.key ?? await readMaskedLine(`API key for ${name}: `);
        if (!key)
            throw new Error("An API key is required.");
        config.profiles[name] = { baseURL, apiKey: key, format: options.format, model, kind: "remote" };
        const activated = !config.activeProfile;
        if (activated)
            config.activeProfile = name;
        saveConfig(config);
        printOk(`Provider "${name}" added${activated ? " and set active" : ""}.`);
    });
    provider.command("remove <name>").description("Remove a provider profile and its stored key").action((name) => {
        const config = requireConfig();
        if (!config.profiles[name])
            throw new Error(`Unknown profile "${name}".`);
        if (config.activeProfile === name)
            throw new Error("Cannot remove the active profile. Switch first with `forge provider use <other>`.");
        delete config.profiles[name];
        deleteProfileSecret(name);
        saveConfig(config);
        printOk(`Removed provider "${name}".`);
    });
    const key = program.command("key").description("Update a provider's stored API key");
    key.command("set <profile>").option("--key <key>", "API key (omit to enter it hidden)").action(async (profileName, options) => {
        const config = requireConfig();
        if (!config.profiles[profileName])
            throw new Error(`Unknown profile "${profileName}". Run \`forge provider list\`.`);
        const value = options.key ?? await readMaskedLine(`API key for ${profileName}: `);
        if (!value)
            throw new Error("An API key is required.");
        config.profiles[profileName].apiKey = value;
        saveConfig(config);
        printOk(`API key updated for "${profileName}".`);
    });
    const runtime = program.command("runtime").description("Inspect local model runtimes");
    runtime.command("list").option("--json").action(async (options) => printRuntimeSummaries(await listRuntimeSummaries(requireConfig()), Boolean(options.json)));
    runtime.command("status").option("--json").action(async (options) => printRuntimeSummaries(await listRuntimeSummaries(requireConfig()), Boolean(options.json)));
    runtime.command("start <kind>").description("Start a local runtime after explicit invocation")
        .option("--model-path <file>", "GGUF path required for llama.cpp")
        .action(async (kind, options) => {
        if (!(kind in requireConfig().runtimes))
            throw new Error(`Unknown runtime: ${kind}`);
        const result = await startRuntime(requireConfig(), kind, { modelPath: options.modelPath });
        printOk(result.owned ? `Started ${kind} (PID ${result.pid}).` : `${kind} is already online.`);
    });
    runtime.command("stop <kind>").description("Stop a runtime process previously started by Forge").action(async (kind) => {
        const config = requireConfig();
        if (!(kind in config.runtimes))
            throw new Error(`Unknown runtime: ${kind}`);
        await stopOwnedRuntime(config, kind);
        printOk(`Stopped ${kind}.`);
    });
    const session = program.command("session").description("Manage saved conversations");
    session.command("list").action(() => listSessions().forEach((name) => console.log(name)));
    session.command("show <name>").option("--json").action((name, options) => {
        const messages = loadSession(name);
        console.log(options.json ? JSON.stringify(messages) : messages.map((message) => `[${message.role}] ${message.content}`).join("\n"));
    });
    session.command("export <name> <file>").action((name, file) => {
        fs.writeFileSync(file, JSON.stringify(loadSession(name), null, 2), "utf-8");
        printOk(`Exported ${name} to ${file}.`);
    });
    const limit = program.command("limit").description("Show or configure subscription and usage limits");
    limit.command("show").option("--json").action((options) => {
        const config = requireConfig();
        const value = config.profiles[config.activeProfile].subscription ?? null;
        const consumed = loadUsageLedger().profiles[config.activeProfile];
        const consumedTokens = (consumed?.promptTokens ?? 0) + (consumed?.completionTokens ?? 0);
        console.log(options.json ? JSON.stringify({ subscription: value, consumedTokens }) : value
            ? `Plan: ${value.name ?? "configured"}; tokens: ${consumedTokens.toLocaleString("en-US")}/${value.tokenLimit?.toLocaleString("en-US") ?? "not set"}; session cost ceiling: ${value.costLimitUsd != null ? `$${value.costLimitUsd}` : "not set"}; reset: ${value.resetAt ?? "not set"}`
            : "No subscription limit is configured. Provider-reported rate limits still appear automatically when available.");
    });
    limit.command("set").description("Configure a plan label and optional token/cost ceiling")
        .option("--name <label>", "Subscription or plan label")
        .option("--tokens <count>", "Token ceiling", (value) => Number(value))
        .option("--cost <usd>", "Cost ceiling in USD", (value) => Number(value))
        .option("--reset <date>", "ISO date/time when the limit resets")
        .action((options) => {
        if (options.tokens != null && (!Number.isInteger(options.tokens) || options.tokens <= 0))
            throw new Error("--tokens must be a positive integer.");
        if (options.cost != null && (!Number.isFinite(options.cost) || options.cost <= 0))
            throw new Error("--cost must be a positive number.");
        let resetAt;
        if (options.reset) {
            const parsed = new Date(options.reset);
            if (Number.isNaN(parsed.getTime()))
                throw new Error("--reset must be a valid ISO date/time.");
            resetAt = parsed.toISOString();
        }
        if (!options.name && options.tokens == null && options.cost == null && !resetAt)
            throw new Error("Set at least one of --name, --tokens, --cost, or --reset.");
        const config = requireConfig();
        config.profiles[config.activeProfile].subscription = { name: options.name, tokenLimit: options.tokens, costLimitUsd: options.cost, resetAt };
        saveConfig(config);
        printOk(`Usage limits configured for ${config.activeProfile}.`);
    });
    limit.command("clear").action(() => {
        const config = requireConfig();
        delete config.profiles[config.activeProfile].subscription;
        saveConfig(config);
        printOk(`Usage limits cleared for ${config.activeProfile}.`);
    });
    limit.command("reset-usage").description("Reset Forge's local cumulative token counter for the active profile").action(() => {
        const config = requireConfig();
        clearProfileUsage(config.activeProfile);
        printOk(`Local usage counter reset for ${config.activeProfile}.`);
    });
    program.command("doctor").description("Diagnose configuration and local runtimes").option("--json").action(async (options) => {
        const config = requireConfig();
        const report = {
            schemaVersion: config.schemaVersion,
            activeProfile: config.activeProfile,
            activeProfileValid: Boolean(config.profiles[config.activeProfile]),
            workspace: config.permissions.workspaceRoot,
            workspaceValid: fs.existsSync(config.permissions.workspaceRoot),
            runtimes: await listRuntimeSummaries(config),
        };
        if (options.json)
            console.log(JSON.stringify(report));
        else {
            printSystem(`Config schema: v${report.schemaVersion}`);
            printSystem(`Active profile: ${report.activeProfileValid ? "ok" : "missing"}`);
            printSystem(`Workspace: ${report.workspaceValid ? "ok" : "missing"} — ${report.workspace}`);
            printRuntimeSummaries(report.runtimes, false);
        }
    });
    addCompletionCommand(program);
    return program;
}
export async function runCli(argv = process.argv) {
    await createProgram().parseAsync(argv);
}
export function reportCliError(error) {
    // If the TUI is (or was) running in alternate-screen/raw mode, restore the
    // terminal before printing — otherwise a crash mid-session leaves the
    // alternate screen's last frame on screen with the cursor hidden and raw
    // mode still engaged, which looks like the whole terminal broke even after
    // the process is gone.
    if (tuiModule)
        tuiModule.unmountActiveTui();
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
// Loaded lazily (and only once) so `forge run`/non-TUI commands never pull in
// Ink; populated by cli.ts's own dynamic import of ./tui.js for the
// interactive path.
let tuiModule;
export function registerTuiModule(module) {
    tuiModule = module;
}
