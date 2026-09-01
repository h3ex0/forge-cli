import type { ProviderRateLimits, ToolCall } from "../providers/types.js";
import type { ToolRisk } from "../security/policy.js";

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  rateLimits?: ProviderRateLimits;
}

export interface ToolActivity {
  id: string;
  name: string;
  risk: ToolRisk;
  status: "waiting" | "running" | "completed" | "denied" | "failed";
  args: Record<string, unknown>;
  result?: string;
  startedAt: number;
  durationMs?: number;
  /** Unified diff preview of what this call would change, shown at approval time. */
  diff?: string;
}

export type AgentEvent =
  | { type: "turn.started"; prompt: string }
  | { type: "text.delta"; delta: string }
  | { type: "message.completed" }
  | { type: "tool.requested"; call: ToolCall; activity: ToolActivity }
  | { type: "tool.updated"; activity: ToolActivity }
  | { type: "usage.updated"; usage: AgentUsage }
  | { type: "turn.cancelled" }
  | { type: "turn.failed"; error: Error }
  | { type: "turn.completed" };

export type AgentEventListener = (event: AgentEvent) => void;
