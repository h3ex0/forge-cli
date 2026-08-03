import fs from "node:fs";
import { Command } from "commander";
import { banner, printError, printOk, printSystem } from "./ui.js";
import { configExists, loadConfig, runSetupWizard, saveConfig } from "./config.js";
import { startRepl } from "./repl.js";
import { createDriver } from "./providers/index.js";
import { activateLocalModel, inspectLocalModel, listRuntimeSummaries, pullLocalModel } from "./runtime/service.js";
import { startRuntime, stopOwnedRuntime } from "./runtime/process.js";
import { listSessions, loadSession } from "./session.js";
import { VERSION } from "./version.js";
function requireConfig() {
    if (!configExists())
        throw new Error("Forge is not configured. Run `forge chat` once to start setup.");
    return loadConfig();
}
async function interactiveConfig() {
    return configExists() ? loadConfig() : runSetupWizard();
}
async function startInteractive() {
    banner("Forge", "Local-first, multi-provider AI coding agent.");
    const config = await interactiveConfig();
    if (!config.activeProfile || !config.profiles[config.activeProfile])
        throw new Error("No active profile. Use `forge model use` or add a provider.");
    await startRepl(config);
}
async function startPreferredInterface() {
    const config = await interactiveConfig();
    if (!config.activeProfile || !config.profiles[config.activeProfile])
        throw new Error("No active profile. Use `forge model use` or add a provider.");
    if (config.ui.mode === "tui") {
        const { startTui } = await import("./tui.js");
        await startTui(config);
        return;
    }
    banner("Forge", "Local-first, multi-provider AI coding agent.");
    await startRepl(config);
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
            powershell: "Register-ArgumentCompleter -Native -CommandName forge -ScriptBlock { param($wordToComplete) 'chat','tui','run','model','runtime','session','doctor','completion' | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_,$_, 'ParameterValue', $_) } }",
            bash: "complete -W 'chat tui run model runtime session doctor completion' forge",
            zsh: "compdef '_arguments \"1:command:(chat tui run model runtime session doctor completion)\"' forge",
            fish: "complete -c forge -f -a 'chat tui run model runtime session doctor completion'",
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
    program.action(startPreferredInterface);
    program.command("chat").description("Open the enhanced interactive REPL").action(startInteractive);
    program.command("tui").description("Open the full-screen terminal workspace").action(async () => {
        const { startTui } = await import("./tui.js");
        await startTui(await interactiveConfig());
    });
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
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
