import chalk from "chalk";
import { estimateCost, estimateMessageTokens, renderUsageStatus } from "./usage.js";
import { loadUsageLedger } from "./usage-store.js";
import { sanitizeTerminalText } from "./tui/sanitize.js";
export function renderStatusLine(state) {
    const profile = state.cfg.profiles[state.cfg.activeProfile];
    const parts = [];
    parts.push(chalk.bgMagenta.black(` ${sanitizeTerminalText(state.cfg.activeProfile)} `));
    parts.push(chalk.bgBlue.black(` ${sanitizeTerminalText(profile.model)} `));
    const pricing = state.pricingCache.get(`${state.cfg.activeProfile}:${profile.model}`);
    const detailed = renderUsageStatus(state.cfg, {
        ...state.usage,
        contextTokens: estimateMessageTokens(state.modelMessages()),
        estimatedCostUsd: estimateCost(profile, state.usage, pricing),
        subscriptionTokensUsed: (() => {
            const entry = loadUsageLedger().profiles[state.cfg.activeProfile];
            return entry ? entry.promptTokens + entry.completionTokens : 0;
        })(),
    }, process.stdout.columns ?? 160);
    parts.push(chalk.dim(sanitizeTerminalText(detailed)));
    return parts.join(" ");
}
export function printStatusLine(state) {
    if (!process.stdout.isTTY)
        return;
    console.log(renderStatusLine(state));
}
