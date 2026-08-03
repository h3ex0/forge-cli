import type { ChatDriver, ChatMessage, StreamCallbacks, ToolCall, ToolDef } from "./types.js";

interface GeminiProfile {
  baseURL: string;
  apiKey: string;
}

function toGeminiContents(messages: ChatMessage[]) {
  let systemInstruction: unknown;
  const contents: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.name, args } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name ?? "tool", response: { content: m.content } } }],
      });
      continue;
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
  }
  return { systemInstruction, contents };
}

function toGeminiTools(tools: ToolDef[]) {
  if (!tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

export function createGeminiDriver(profile: GeminiProfile): ChatDriver {
  return {
    async streamChat(messages, tools, model, cb: StreamCallbacks) {
      const url = `${profile.baseURL.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse`;
      const { systemInstruction, contents } = toGeminiContents(messages);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": profile.apiKey,
          },
          body: JSON.stringify({
            contents,
            systemInstruction,
            tools: toGeminiTools(tools),
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
      const toolCalls: ToolCall[] = [];
      let usage: { promptTokens?: number; completionTokens?: number } | undefined;
      let callIdCounter = 0;

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
            if (!payload) continue;
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
            if (json.usageMetadata) {
              usage = {
                promptTokens: json.usageMetadata.promptTokenCount,
                completionTokens: json.usageMetadata.candidatesTokenCount,
              };
            }
            const parts = json.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
              if (part.text) cb.onTextDelta(part.text);
              if (part.functionCall) {
                callIdCounter += 1;
                toolCalls.push({
                  id: `call_${callIdCounter}`,
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                });
              }
            }
          }
        }
      } catch (err) {
        cb.onError(err as Error);
        return;
      }

      if (toolCalls.length > 0) cb.onToolCallsComplete(toolCalls);
      cb.onDone(usage);
    },
  };
}
