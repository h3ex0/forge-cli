import { banner, printError } from "./ui.js";
import { configExists, loadConfig, runSetupWizard } from "./config.js";
import { startRepl } from "./repl.js";
async function main() {
    banner("Forge", "Your own multi-provider AI CLI agent — own your keys, own your tools.");
    const cfg = configExists() ? loadConfig() : await runSetupWizard();
    if (!cfg.activeProfile || !cfg.profiles[cfg.activeProfile]) {
        printError("No active provider profile configured. Delete ~/.forge/config.json and restart to re-run setup.");
        process.exit(1);
    }
    await startRepl(cfg);
}
main().catch((err) => {
    printError(`Fatal error: ${err?.message ?? err}`);
    process.exit(1);
});
