import ora from "ora";
import { colors, printError, printOk, printSystem, printWarn, divider } from "../ui.js";
import { getToolDefs } from "../tools/index.js";
import { listSessions, saveSession, loadSession, defaultSessionName } from "../session.js";
import { fetchModels } from "../providers/models.js";
export async function handleCommand(input, state) {
    if (!input.startsWith("/"))
        return "not-a-command";
    const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
        case "help": {
            console.log(colors.accent("\nSlash commands:"));
            console.log("  /help                     Show this help");
            console.log("  /provider list            List configured provider profiles");
            console.log("  /provider use <name>      Switch active provider profile");
            console.log("  /provider add             Interactively add a new provider profile");
            console.log("  /model                    Pick a model from a numbered list");
            console.log("  /model <name>             Set the model directly by id");
            console.log("  /key <profile> <key>      Update the API key for a profile");
            console.log("  /tools                    List available agent tools");
            console.log("  /clear                    Clear conversation history");
            console.log("  /history                  Show conversation so far");
            console.log("  /save [name]              Save current session");
            console.log("  /load <name>              Load a saved session");
            console.log("  /sessions                 List saved sessions");
            console.log("  /cost                     Show cumulative token usage");
            console.log("  /theme                    Cycle color accents (cosmetic)");
            console.log("  /exit                     Quit forge\n");
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
            if (arg) {
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
            printOk(`API key updated for "${profileName}".`);
            return "handled";
        }
        case "tools": {
            console.log(colors.accent("\nAvailable agent tools:"));
            for (const t of getToolDefs()) {
                console.log(`  ${colors.tool(t.name)} — ${t.description}`);
            }
            console.log();
            return "handled";
        }
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
            printSystem("Themes are cosmetic-only for now — colors rotate automatically per session.");
            return "handled";
        }
        default:
            printWarn(`Unknown command: /${cmd}. Type /help for a list.`);
            return "handled";
    }
}
