import { createDriver } from "../providers/index.js";
import { createTools } from "../tools/index.js";
import { decidePermission } from "../security/policy.js";
import { recordUsage } from "../usage-store.js";
const MAX_TOOL_ITERATIONS = 40;
const DEFAULT_SUBAGENT_DEPTH = 1;
function parseToolArguments(call) {
    try {
        const value = JSON.parse(call.arguments || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    catch {
        return {};
    }
}
/**
 * Runs provider turns, tools, approvals, usage accounting, and cancellation
 * independently of a terminal frontend.
 */
export class AgentSession {
    messages;
    usage;
    config;
    approve;
    getContextMessages;
    usageRecorder;
    subagentDepth;
    listeners = new Set();
    abortController = null;
    constructor(options) {
        this.config = options.config;
        this.messages = options.messages;
        this.usage = options.usage ?? { promptTokens: 0, completionTokens: 0 };
        this.approve = options.approve;
        this.getContextMessages = options.getContextMessages ?? (() => this.messages);
        this.usageRecorder = options.recordUsage ?? ((profile, promptTokens, completionTokens) => { recordUsage(profile, promptTokens, completionTokens); });
        this.subagentDepth = options.subagentDepth ?? DEFAULT_SUBAGENT_DEPTH;
    }
    /** Build a tool that delegates a self-contained task to a fresh, nested AgentSession. */
    createSpawnAgentTool() {
        return {
            def: {
                name: "spawn_agent",
                description: "Delegate a self-contained task to a fresh subagent with its own tool loop and context window. Use it to keep exploratory or multi-step side-work out of the main conversation; it returns only the subagent's final report. Optionally target a different configured provider profile.",
                parameters: {
                    type: "object",
                    properties: {
                        task: { type: "string", description: "A complete, self-contained description of the task. The subagent has no memory of this conversation." },
                        profile: { type: "string", description: "Optional configured provider profile name to run the subagent on. Defaults to the active profile." },
                    },
                    required: ["task"],
                    additionalProperties: false,
                },
            },
            risk: "process",
            destructive: true,
            execute: async (args, signal) => {
                const task = typeof args.task === "string" ? args.task : "";
                if (!task.trim())
                    throw new Error("spawn_agent requires a non-empty task.");
                const profileName = typeof args.profile === "string" && args.profile ? args.profile : this.config.activeProfile;
                if (!this.config.profiles[profileName])
                    throw new Error(`Unknown provider profile "${profileName}".`);
                const subConfig = { ...this.config, activeProfile: profileName };
                const subMessages = [{ role: "system", content: "You are a focused subagent working inside the same workspace as the primary agent. Complete exactly the delegated task, using tools as needed, then reply with a concise final report of what you found or changed. You cannot ask the user questions — make reasonable assumptions and note them." }];
                const subSession = new AgentSession({
                    config: subConfig,
                    messages: subMessages,
                    approve: this.approve,
                    recordUsage: this.usageRecorder,
                    subagentDepth: this.subagentDepth - 1,
                });
                let failure;
                const unsubscribe = subSession.subscribe((event) => {
                    if (event.type === "turn.failed")
                        failure = event.error;
                });
                try {
                    await subSession.send(task);
                }
                finally {
                    unsubscribe();
                    this.usage.promptTokens += subSession.usage.promptTokens;
                    this.usage.completionTokens += subSession.usage.completionTokens;
                    this.emit({ type: "usage.updated", usage: { ...this.usage } });
                }
                if (signal?.aborted)
                    throw new Error("Cancelled.");
                if (failure)
                    throw failure;
                const report = subMessages.filter((message) => message.role === "assistant").at(-1)?.content;
                return report?.trim() || "(subagent completed without producing a final report)";
            },
        };
    }
    get busy() {
        return this.abortController !== null;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    cancel() {
        this.abortController?.abort();
    }
    /**
     * Submit one user prompt and run its bounded model/tool loop.
     *
     * Errors are emitted as `turn.failed`; callers only receive a rejection when
     * the session cannot start (for example, because another turn is active).
     */
    async send(prompt) {
        if (this.busy)
            throw new Error("Forge is already working. Cancel the active turn before sending another prompt.");
        const trimmed = prompt.trim();
        if (!trimmed)
            return;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        this.messages.push({ role: "user", content: trimmed });
        this.emit({ type: "turn.started", prompt: trimmed });
        try {
            await this.runTurn(signal);
            if (signal.aborted)
                this.emit({ type: "turn.cancelled" });
            else
                this.emit({ type: "turn.completed" });
        }
        catch (error) {
            if (signal.aborted)
                this.emit({ type: "turn.cancelled" });
            else
                this.emit({ type: "turn.failed", error: error instanceof Error ? error : new Error(String(error)) });
        }
        finally {
            this.abortController = null;
        }
    }
    emit(event) {
        for (const listener of this.listeners)
            listener(event);
    }
    async runTurn(signal) {
        const profile = this.config.profiles[this.config.activeProfile];
        if (!profile)
            throw new Error(`Active profile "${this.config.activeProfile}" is not configured.`);
        const driver = createDriver(profile);
        const allTools = createTools({ workspaceRoot: this.config.permissions.workspaceRoot });
        if (this.subagentDepth > 0)
            allTools.push(this.createSpawnAgentTool());
        const availableTools = this.config.routing.offline ? allTools.filter((item) => item.risk !== "network") : allTools;
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
            if (signal.aborted)
                return;
            let assistantText = "";
            let toolCalls = [];
            let providerError;
            await driver.streamChat(this.getContextMessages(), availableTools.map((item) => item.def), profile.model, {
                onTextDelta: (delta) => {
                    assistantText += delta;
                    this.emit({ type: "text.delta", delta });
                },
                onToolCallsComplete: (calls) => { toolCalls = calls; },
                onDone: (value) => {
                    const promptTokens = value?.promptTokens ?? 0;
                    const completionTokens = value?.completionTokens ?? 0;
                    this.usage.promptTokens += promptTokens;
                    this.usage.completionTokens += completionTokens;
                    if (promptTokens || completionTokens) {
                        try {
                            this.usageRecorder(this.config.activeProfile, promptTokens, completionTokens);
                        }
                        catch { /* usage accounting is best-effort and must not fail a completed model turn */ }
                    }
                    if (value?.rateLimits)
                        this.usage.rateLimits = value.rateLimits;
                    this.emit({ type: "usage.updated", usage: { ...this.usage } });
                },
                onError: (error) => { providerError = error; },
            }, signal);
            if (signal.aborted)
                return;
            if (providerError)
                throw providerError;
            if (!toolCalls.length) {
                this.messages.push({ role: "assistant", content: assistantText });
                this.emit({ type: "message.completed" });
                return;
            }
            this.messages.push({ role: "assistant", content: assistantText, tool_calls: toolCalls });
            this.emit({ type: "message.completed" });
            for (const call of toolCalls) {
                if (signal.aborted)
                    return;
                const tool = availableTools.find((item) => item.def.name === call.name);
                if (!tool) {
                    this.messages.push({ role: "tool", content: `Error: unknown tool "${call.name}"`, tool_call_id: call.id, name: call.name });
                    continue;
                }
                const args = parseToolArguments(call);
                let diff;
                try {
                    diff = tool.preview?.(args);
                }
                catch { /* preview is best-effort; approval still proceeds without it */ }
                const activity = { id: call.id, name: call.name, risk: tool.risk, status: "waiting", args, diff, startedAt: Date.now() };
                this.emit({ type: "tool.requested", call, activity: { ...activity } });
                const decision = decidePermission(this.config.permissions.mode, tool.risk);
                const allowed = decision === "allow" || (decision === "ask" && await this.approve({ call, activity }));
                if (!allowed) {
                    activity.status = "denied";
                    activity.result = decision === "deny" ? `${this.config.permissions.mode} mode blocks ${tool.risk} tools.` : "User denied permission.";
                    activity.durationMs = Date.now() - activity.startedAt;
                    this.emit({ type: "tool.updated", activity: { ...activity } });
                    this.messages.push({ role: "tool", content: activity.result, tool_call_id: call.id, name: call.name });
                    continue;
                }
                activity.status = "running";
                this.emit({ type: "tool.updated", activity: { ...activity } });
                try {
                    activity.result = await tool.execute(args, signal);
                    activity.status = "completed";
                }
                catch (error) {
                    activity.result = `Error: ${error instanceof Error ? error.message : String(error)}`;
                    activity.status = signal.aborted ? "denied" : "failed";
                }
                activity.durationMs = Date.now() - activity.startedAt;
                this.emit({ type: "tool.updated", activity: { ...activity } });
                this.messages.push({ role: "tool", content: activity.result, tool_call_id: call.id, name: call.name });
            }
        }
        throw new Error(`Reached the ${MAX_TOOL_ITERATIONS}-iteration tool limit for this turn.`);
    }
}
