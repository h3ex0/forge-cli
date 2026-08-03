import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
marked.use(markedTerminal());
const flame = gradient(["#ff512f", "#f09819", "#ff512f"]);
const cool = gradient(["#00c6ff", "#0072ff"]);
export function banner(name, tagline) {
    const text = figlet.textSync(name.toUpperCase(), { font: "Standard" });
    console.log(flame.multiline(text));
    console.log(chalk.gray("  " + tagline));
    console.log();
}
export function renderMarkdown(text) {
    try {
        return marked.parse(text).trimEnd();
    }
    catch {
        return text;
    }
}
export const colors = {
    user: chalk.cyanBright.bold,
    assistant: chalk.greenBright.bold,
    system: chalk.gray,
    error: chalk.redBright.bold,
    warn: chalk.yellowBright,
    ok: chalk.greenBright,
    dim: chalk.gray,
    accent: chalk.magentaBright,
    tool: chalk.blueBright,
    cost: chalk.yellow,
    prompt: cool,
};
export function printUser(text) {
    console.log(colors.user("You ›"), text);
}
export function printAssistantPrefix(modelLabel) {
    process.stdout.write(colors.assistant(`Forge (${modelLabel}) › `));
}
export function printSystem(text) {
    console.log(colors.system(text));
}
export function printError(text) {
    console.log(colors.error("✖ " + text));
}
export function printWarn(text) {
    console.log(colors.warn("⚠ " + text));
}
export function printOk(text) {
    console.log(colors.ok("✔ " + text));
}
export function printToolCall(name, args) {
    console.log(colors.tool(`  ↪ tool:${name}`), colors.dim(JSON.stringify(args)));
}
export function printToolResult(text) {
    const truncated = text.length > 800 ? text.slice(0, 800) + " …[truncated]" : text;
    console.log(colors.dim("  " + truncated.split("\n").join("\n  ")));
}
export function divider() {
    console.log(colors.dim("─".repeat(process.stdout.columns ? Math.min(process.stdout.columns, 60) : 60)));
}
