export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ProviderRateLimits {
  tokenLimit?: number;
  tokenRemaining?: number;
  requestLimit?: number;
  requestRemaining?: number;
  reset?: string;
}

export interface StreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  rateLimits?: ProviderRateLimits;
}

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void;
  onToolCallsComplete: (calls: ToolCall[]) => void;
  onDone: (usage?: StreamUsage) => void;
  onError: (err: Error) => void;
}

export interface ChatDriver {
  streamChat(
    messages: ChatMessage[],
    tools: ToolDef[],
    model: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void>;
}
