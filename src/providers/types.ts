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

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void;
  onToolCallsComplete: (calls: ToolCall[]) => void;
  onDone: (usage?: { promptTokens?: number; completionTokens?: number }) => void;
  onError: (err: Error) => void;
}

export interface ChatDriver {
  streamChat(
    messages: ChatMessage[],
    tools: ToolDef[],
    model: string,
    callbacks: StreamCallbacks
  ): Promise<void>;
}
