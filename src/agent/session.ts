import { createDriver } from "../providers/index.js";
import type { ChatMessage, ToolCall } from "../providers/types.js";
import type { ForgeConfig } from "../config.js";
import { createTools } from "../tools/index.js";
import { decidePermission } from "../security/policy.js";
import type { AgentEvent, AgentEventListener, AgentUsage, ToolActivity } from "./events.js";
import { recordUsage } from "../usage-store.js";

const MAX_TOOL_ITERATIONS = 10;

export interface ApprovalRequest {
  call: ToolCall;
  activity: ToolActivity;
}

export interface AgentSessionOptions {
  config: ForgeConfig;
  messages: ChatMessage[];
  usage?: AgentUsage;
  getContextMessages?: () => ChatMessage[];
  approve: (request: ApprovalRequest) => Promise<boolean>;
  recordUsage?: (profile: string, promptTokens: number, completionTokens: number) => void;
}

function parseToolArguments(call: ToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Runs provider turns, tools, approvals, usage accounting, and cancellation
 * independently of a terminal frontend.
 */
export class AgentSession {
  readonly messages: ChatMessage[];
  readonly usage: AgentUsage;
  private readonly config: ForgeConfig;
  private readonly approve: AgentSessionOptions["approve"];
  private readonly getContextMessages: () => ChatMessage[];
  private readonly usageRecorder: NonNullable<AgentSessionOptions["recordUsage"]>;
  private readonly listeners = new Set<AgentEventListener>();
  private abortController: AbortController | null = null;

  constructor(options: AgentSessionOptions) {
    this.config = options.config;
    this.messages = options.messages;
    this.usage = options.usage ?? { promptTokens: 0, completionTokens: 0 };
    this.approve = options.approve;
    this.getContextMessages = options.getContextMessages ?? (() => this.messages);
    this.usageRecorder = options.recordUsage ?? ((profile, promptTokens, completionTokens) => { recordUsage(profile, promptTokens, completionTokens); });
  }

  get busy(): boolean {
    return this.abortController !== null;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    this.abortController?.abort();
  }

  /**
   * Submit one user prompt and run its bounded model/tool loop.
   *
   * Errors are emitted as `turn.failed`; callers only receive a rejection when
   * the session cannot start (for example, because another turn is active).
   */
  async send(prompt: string): Promise<void> {
    if (this.busy) throw new Error("Forge is already working. Cancel the active turn before sending another prompt.");
    const trimmed = prompt.trim();
    if (!trimmed) return;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.messages.push({ role: "user", content: trimmed });
    this.emit({ type: "turn.started", prompt: trimmed });

    try {
      await this.runTurn(signal);
      if (signal.aborted) this.emit({ type: "turn.cancelled" });
      else this.emit({ type: "turn.completed" });
    } catch (error) {
      if (signal.aborted) this.emit({ type: "turn.cancelled" });
      else this.emit({ type: "turn.failed", error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      this.abortController = null;
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async runTurn(signal: AbortSignal): Promise<void> {
    const profile = this.config.profiles[this.config.activeProfile];
    if (!profile) throw new Error(`Active profile "${this.config.activeProfile}" is not configured.`);
    const driver = createDriver(profile);
    const allTools = createTools({ workspaceRoot: this.config.permissions.workspaceRoot });
    const availableTools = this.config.routing.offline ? allTools.filter((item) => item.risk !== "network") : allTools;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      if (signal.aborted) return;
      let assistantText = "";
      let toolCalls: ToolCall[] = [];
      let providerError: Error | undefined;

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
            try { this.usageRecorder(this.config.activeProfile, promptTokens, completionTokens); }
            catch { /* usage accounting is best-effort and must not fail a completed model turn */ }
          }
          if (value?.rateLimits) this.usage.rateLimits = value.rateLimits;
          this.emit({ type: "usage.updated", usage: { ...this.usage } });
        },
        onError: (error) => { providerError = error; },
      }, signal);

      if (signal.aborted) return;
      if (providerError) throw providerError;
      if (!toolCalls.length) {
        this.messages.push({ role: "assistant", content: assistantText });
        this.emit({ type: "message.completed" });
        return;
      }

      this.messages.push({ role: "assistant", content: assistantText, tool_calls: toolCalls });
      this.emit({ type: "message.completed" });

      for (const call of toolCalls) {
        if (signal.aborted) return;
        const tool = availableTools.find((item) => item.def.name === call.name);
        if (!tool) {
          this.messages.push({ role: "tool", content: `Error: unknown tool "${call.name}"`, tool_call_id: call.id, name: call.name });
          continue;
        }
        const args = parseToolArguments(call);
        const activity: ToolActivity = { id: call.id, name: call.name, risk: tool.risk, status: "waiting", args, startedAt: Date.now() };
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
        } catch (error) {
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
