import { AppState } from "./repl-state.js";
import { createLineSource } from "./line-source.js";
import { handleCommand } from "./commands/index.js";
import { createDriver } from "./providers/index.js";
import { fetchModels } from "./providers/models.js";
import { createTools } from "./tools/index.js";
import { decidePermission } from "./security/policy.js";
import { printStatusLine } from "./statusline.js";
import { colors, divider, printAssistantPrefix, printError, printOk, printSystem, printToolCall, printToolResult, printWarn, } from "./ui.js";
const MAX_TOOL_ITERATIONS = 10;
async function runTurn(state) {
    const profile = state.cfg.profiles[state.cfg.activeProfile];
    const driver = createDriver(profile);
    const toolSpecs = createTools({ workspaceRoot: state.cfg.permissions.workspaceRoot });
    const availableTools = state.cfg.routing.offline ? toolSpecs.filter((tool) => tool.risk !== "network") : toolSpecs;
    const tools = availableTools.map((tool) => tool.def);
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        let assistantText = "";
        let toolCalls = [];
        let errored = false;
        let printedPrefix = false;
        await driver.streamChat(state.modelMessages(), tools, profile.model, {
            onTextDelta: (delta) => {
                if (!printedPrefix) {
                    printAssistantPrefix(profile.model);
                    printedPrefix = true;
                }
                process.stdout.write(delta);
                assistantText += delta;
            },
            onToolCallsComplete: (calls) => {
                toolCalls = calls;
            },
            onDone: (usage) => {
                if (usage?.promptTokens)
                    state.usage.promptTokens += usage.promptTokens;
                if (usage?.completionTokens)
                    state.usage.completionTokens += usage.completionTokens;
            },
            onError: (err) => {
                errored = true;
                printError(`Provider error: ${err.message}`);
            },
        });
        if (errored)
            return;
        if (printedPrefix) {
            console.log();
        }
        if (toolCalls.length === 0) {
            if (!assistantText) {
                printWarn("Provider returned an empty response (no text, no tool calls, no error). Try again or check /model.");
            }
            state.messages.push({ role: "assistant", content: assistantText });
            return;
        }
        state.messages.push({ role: "assistant", content: assistantText, tool_calls: toolCalls });
        for (const call of toolCalls) {
            let args = {};
            try {
                args = JSON.parse(call.arguments || "{}");
            }
            catch {
                // leave args empty if malformed
            }
            printToolCall(call.name, args);
            const tool = availableTools.find((candidate) => candidate.def.name === call.name);
            let resultText;
            if (!tool) {
                resultText = `Error: unknown tool "${call.name}"`;
            }
            else {
                const decision = decidePermission(state.cfg.permissions.mode, tool.risk);
                if (decision === "deny") {
                    resultText = `Permission denied: ${state.cfg.permissions.mode} mode blocks ${tool.risk} tools.`;
                    printWarn(resultText);
                }
                else if (decision === "ask") {
                    const ok = await state.confirm(`Allow tool "${call.name}" to run?`);
                    if (!ok) {
                        resultText = "User denied permission to run this tool.";
                        printWarn("Denied.");
                    }
                    else {
                        try {
                            resultText = await tool.execute(args);
                            printToolResult(resultText);
                        }
                        catch (err) {
                            resultText = `Error: ${err.message}`;
                            printError(resultText);
                        }
                    }
                }
                else {
                    try {
                        resultText = await tool.execute(args);
                        printToolResult(resultText);
                    }
                    catch (err) {
                        resultText = `Error: ${err.message}`;
                        printError(resultText);
                    }
                }
            }
            state.messages.push({
                role: "tool",
                content: resultText,
                tool_call_id: call.id,
                name: call.name,
            });
        }
        // loop again so the model sees tool results and continues
    }
    printWarn("Reached max tool iterations for this turn.");
}
export async function startRepl(cfg) {
    const reader = createLineSource();
    const state = new AppState(cfg, reader);
    printSystem(`Active provider: ${state.cfg.activeProfile} (${state.cfg.profiles[state.cfg.activeProfile].model})`);
    printSystem("Type /help for commands, or just start chatting. Ctrl+C or /exit to quit.\n");
    // Best-effort: warm the pricing cache for the active profile so the status
    // line can show an estimated cost from the first turn onward.
    fetchModels(state.cfg.profiles[state.cfg.activeProfile])
        .then((models) => {
        for (const m of models)
            state.pricingCache.set(`${state.cfg.activeProfile}:${m.id}`, m);
    })
        .catch(() => {
        // provider has no /models endpoint or pricing info — statusline just omits cost
    });
    // A single reader queue (see line-source.ts) drives both the main prompt and
    // any nested confirm() prompts for destructive tools, so lines are never
    // dropped (piped/multi-line bursts) and never double-consumed (racing listeners).
    while (!state.reader.isExhausted()) {
        printStatusLine(state);
        const input = await state.ask(colors.prompt("You › "));
        if (state.reader.isExhausted() && !input)
            break;
        const trimmed = input.trim();
        if (!trimmed)
            continue;
        const cmdResult = await handleCommand(trimmed, state);
        if (cmdResult === "exit") {
            printOk("Goodbye.");
            state.reader.close();
            break;
        }
        if (state.pendingPrompt) {
            const prompt = state.pendingPrompt;
            state.pendingPrompt = null;
            state.messages.push({ role: "user", content: prompt });
            try {
                await runTurn(state);
            }
            catch (err) {
                printError(`Unexpected error: ${err.message}`);
            }
            divider();
            continue;
        }
        if (cmdResult === "handled")
            continue;
        state.messages.push({ role: "user", content: trimmed });
        try {
            await runTurn(state);
        }
        catch (err) {
            printError(`Unexpected error: ${err.message}`);
        }
        divider();
    }
}
