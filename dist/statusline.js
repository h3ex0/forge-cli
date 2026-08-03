import chalk from "chalk";
function fmtNum(n) {
    return n.toLocaleString("en-US");
}
function fmtCost(n) {
    if (n < 0.01)
        return "<$0.01";
    return `$${n.toFixed(2)}`;
}
export function renderStatusLine(state) {
    const profile = state.cfg.profiles[state.cfg.activeProfile];
    const parts = [];
    parts.push(chalk.bgMagenta.black(` ${state.cfg.activeProfile} `));
    parts.push(chalk.bgBlue.black(` ${profile.model} `));
    const { promptTokens, completionTokens } = state.usage;
    const tokenPart = `↑${fmtNum(promptTokens)} ↓${fmtNum(completionTokens)}`;
    parts.push(chalk.bgBlackBright.white(` ${tokenPart} `));
    const pricing = state.pricingCache.get(`${state.cfg.activeProfile}:${profile.model}`);
    if (pricing && (pricing.inputPricePerMillion || pricing.outputPricePerMillion)) {
        const cost = (promptTokens / 1_000_000) * (pricing.inputPricePerMillion ?? 0) +
            (completionTokens / 1_000_000) * (pricing.outputPricePerMillion ?? 0);
        parts.push(chalk.bgGreen.black(` est. ${fmtCost(cost)} `));
    }
    return parts.join(" ");
}
export function printStatusLine(state) {
    if (!process.stdout.isTTY)
        return;
    console.log(renderStatusLine(state));
}
