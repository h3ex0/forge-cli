import chalk from "chalk";
import type { AppState } from "./repl-state.js";

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(n: number): string {
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function renderStatusLine(state: AppState): string {
  const profile = state.cfg.profiles[state.cfg.activeProfile];
  const parts: string[] = [];
  parts.push(chalk.bgMagenta.black(` ${state.cfg.activeProfile} `));
  parts.push(chalk.bgBlue.black(` ${profile.model} `));

  const { promptTokens, completionTokens } = state.usage;
  const tokenPart = `↑${fmtNum(promptTokens)} ↓${fmtNum(completionTokens)}`;
  parts.push(chalk.bgBlackBright.white(` ${tokenPart} `));

  const pricing = state.pricingCache.get(`${state.cfg.activeProfile}:${profile.model}`);
  if (pricing && (pricing.inputPricePerMillion || pricing.outputPricePerMillion)) {
    const cost =
      (promptTokens / 1_000_000) * (pricing.inputPricePerMillion ?? 0) +
      (completionTokens / 1_000_000) * (pricing.outputPricePerMillion ?? 0);
    parts.push(chalk.bgGreen.black(` est. ${fmtCost(cost)} `));
  }

  return parts.join(" ");
}

export function printStatusLine(state: AppState) {
  if (!process.stdout.isTTY) return;
  console.log(renderStatusLine(state));
}
