import type { ChatDriver, ChatMessage, StreamCallbacks, ToolCall, ToolDef } from "./types.js";

interface OpenAIProfile {
  baseURL: string;
  apiKey: string;
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAITools(tools: ToolDef[]): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function createOpenAIDriver(profile: OpenAIProfile): ChatDriver {
  return {
    async streamChat(messages, tools, model, cb: StreamCallbacks) {
      const url = `${profile.baseURL.replace(/\/$/, "")}/chat/completions`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${profile.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: toOpenAIMessages(messages),
            tools: toOpenAITools(tools),
            stream: true,
            stream_options: { include_usage: true },
          }),
        });
      } catch (err) {
        cb.onError(err as Error);
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => res.statusText);
        cb.onError(new Error(`HTTP ${res.status}: ${text}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const pendingToolCalls: Map<number, ToolCall> = new Map();
      let usage: { promptTokens?: number; completionTokens?: number } | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            let json: any;
            try {
              json = JSON.parse(payload);
            } catch {
              continue;
            }
            if (json.error) {
              cb.onError(new Error(json.error.message || JSON.stringify(json.error)));
              return;
            }
            if (json.usage) {
              usage = {
                promptTokens: json.usage.prompt_tokens,
                completionTokens: json.usage.completion_tokens,
              };
            }
            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;
            if (delta?.content) cb.onTextDelta(delta.content);
            if (delta?.tool_calls) {
              for (const tcDelta of delta.tool_calls) {
                const idx = tcDelta.index ?? 0;
                const existing = pendingToolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
                if (tcDelta.id) existing.id = tcDelta.id;
                if (tcDelta.function?.name) existing.name += tcDelta.function.name;
                if (tcDelta.function?.arguments) existing.arguments += tcDelta.function.arguments;
                pendingToolCalls.set(idx, existing);
              }
            }
          }
        }
      } catch (err) {
        cb.onError(err as Error);
        return;
      }

      if (pendingToolCalls.size > 0) {
        cb.onToolCallsComplete(Array.from(pendingToolCalls.values()));
      }
      cb.onDone(usage);
    },
  };
}
