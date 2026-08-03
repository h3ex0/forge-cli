import { AppState } from "./repl-state.js";
import { createLineSource } from "./line-source.js";
import { handleCommand } from "./commands/index.js";
import { AgentSession } from "./agent/session.js";
import { fetchModels } from "./providers/models.js";
import { printStatusLine } from "./statusline.js";
import {
  colors,
  divider,
  printAssistantPrefix,
  printError,
  printOk,
  printSystem,
  printToolCall,
  printToolResult,
  printWarn,
} from "./ui.js";
import type { ForgeConfig } from "./config.js";
import { sanitizeTerminalText, sanitizeToolArguments } from "./tui/sanitize.js";

async function runTurn(state: AppState, prompt: string): Promise<void> {
  let assistantStarted = false;
  const session = new AgentSession({
    config: state.cfg,
    messages: state.messages,
    usage: state.usage,
    getContextMessages: () => state.modelMessages(),
    approve: ({ call }) => state.confirm(`Allow tool "${call.name}" to run?`),
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "text.delta") {
      if (!assistantStarted) {
        printAssistantPrefix(state.cfg.profiles[state.cfg.activeProfile].model);
        assistantStarted = true;
      }
      process.stdout.write(sanitizeTerminalText(event.delta));
    } else if (event.type === "tool.requested") {
      printToolCall(sanitizeTerminalText(event.activity.name), sanitizeToolArguments(event.activity.args));
    } else if (event.type === "tool.updated" && ["completed", "failed", "denied"].includes(event.activity.status)) {
      printToolResult(sanitizeTerminalText(event.activity.result ?? event.activity.status));
    } else if (event.type === "turn.failed") {
      printError(sanitizeTerminalText(event.error.message));
    } else if (event.type === "turn.cancelled") {
      printWarn("Turn cancelled.");
    }
  });
  try {
    await session.send(prompt);
    if (assistantStarted) console.log();
  } finally {
    unsubscribe();
  }
}

export async function startRepl(cfg: ForgeConfig): Promise<void> {
  const reader = createLineSource();
  const state = new AppState(cfg, reader);

  printSystem(`Active provider: ${state.cfg.activeProfile} (${state.cfg.profiles[state.cfg.activeProfile].model})`);
  printSystem("Type /help for commands, or just start chatting. Ctrl+C or /exit to quit.\n");

  fetchModels(state.cfg.profiles[state.cfg.activeProfile])
    .then((models) => {
      for (const model of models) state.pricingCache.set(`${state.cfg.activeProfile}:${model.id}`, model);
    })
    .catch(() => undefined);

  while (!state.reader.isExhausted()) {
    printStatusLine(state);
    const input = await state.ask(colors.prompt("You › "));
    if (state.reader.isExhausted() && !input) break;
    const trimmed = input.trim();
    if (!trimmed) continue;

    const cmdResult = await handleCommand(trimmed, state);
    if (cmdResult === "exit") {
      printOk("Goodbye.");
      state.reader.close();
      break;
    }
    if (state.pendingPrompt) {
      const pending = state.pendingPrompt;
      state.pendingPrompt = null;
      await runTurn(state, pending).catch((error: unknown) => printError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`));
      divider();
      continue;
    }
    if (cmdResult === "handled") continue;
    await runTurn(state, trimmed).catch((error: unknown) => printError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`));
    divider();
  }
}
