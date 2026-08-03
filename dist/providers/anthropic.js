function buildRequest(messages, tools) {
    let system = "";
    const out = [];
    for (const m of messages) {
        if (m.role === "system") {
            system += (system ? "\n" : "") + m.content;
            continue;
        }
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            const content = [];
            if (m.content)
                content.push({ type: "text", text: m.content });
            for (const tc of m.tool_calls) {
                let input = {};
                try {
                    input = JSON.parse(tc.arguments || "{}");
                }
                catch {
                    input = {};
                }
                content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
            }
            out.push({ role: "assistant", content });
            continue;
        }
        if (m.role === "tool") {
            out.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
            });
            continue;
        }
        out.push({ role: m.role, content: m.content });
    }
    const anthropicTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
    }));
    return { system, messages: out, tools: anthropicTools.length ? anthropicTools : undefined };
}
export function createAnthropicDriver(profile) {
    return {
        async streamChat(messages, tools, model, cb, signal) {
            const url = `${profile.baseURL.replace(/\/$/, "")}/messages`;
            const { system, messages: msgs, tools: toolDefs } = buildRequest(messages, tools);
            let res;
            try {
                res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": profile.apiKey,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model,
                        system: system || undefined,
                        messages: msgs,
                        tools: toolDefs,
                        max_tokens: 8192,
                        stream: true,
                    }),
                    signal,
                });
            }
            catch (err) {
                cb.onError(err);
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
            const blocks = new Map();
            let usage;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith("data:"))
                            continue;
                        const payload = trimmed.slice(5).trim();
                        if (!payload)
                            continue;
                        let json;
                        try {
                            json = JSON.parse(payload);
                        }
                        catch {
                            continue;
                        }
                        switch (json.type) {
                            case "error": {
                                cb.onError(new Error(json.error?.message || JSON.stringify(json.error)));
                                return;
                            }
                            case "content_block_start": {
                                const idx = json.index;
                                if (json.content_block?.type === "tool_use") {
                                    blocks.set(idx, {
                                        type: "tool_use",
                                        toolCall: { id: json.content_block.id, name: json.content_block.name, arguments: "" },
                                    });
                                }
                                else {
                                    blocks.set(idx, { type: "text" });
                                }
                                break;
                            }
                            case "content_block_delta": {
                                const idx = json.index;
                                const block = blocks.get(idx);
                                if (json.delta?.type === "text_delta") {
                                    cb.onTextDelta(json.delta.text);
                                }
                                else if (json.delta?.type === "input_json_delta" && block?.toolCall) {
                                    block.toolCall.arguments += json.delta.partial_json ?? "";
                                }
                                break;
                            }
                            case "message_delta": {
                                if (json.usage) {
                                    usage = { ...usage, completionTokens: json.usage.output_tokens };
                                }
                                break;
                            }
                            case "message_start": {
                                if (json.message?.usage) {
                                    usage = { promptTokens: json.message.usage.input_tokens };
                                }
                                break;
                            }
                            default:
                                break;
                        }
                    }
                }
            }
            catch (err) {
                cb.onError(err);
                return;
            }
            const toolCalls = Array.from(blocks.values())
                .filter((b) => b.type === "tool_use" && b.toolCall)
                .map((b) => b.toolCall);
            if (toolCalls.length > 0)
                cb.onToolCallsComplete(toolCalls);
            const numberHeader = (name) => {
                const value = res.headers.get(name);
                if (!value)
                    return undefined;
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
            };
            const rateLimits = {
                tokenLimit: numberHeader("anthropic-ratelimit-tokens-limit"),
                tokenRemaining: numberHeader("anthropic-ratelimit-tokens-remaining"),
                requestLimit: numberHeader("anthropic-ratelimit-requests-limit"),
                requestRemaining: numberHeader("anthropic-ratelimit-requests-remaining"),
                reset: res.headers.get("anthropic-ratelimit-tokens-reset") ?? res.headers.get("anthropic-ratelimit-requests-reset") ?? undefined,
            };
            cb.onDone({ ...usage, rateLimits: Object.values(rateLimits).some((value) => value !== undefined) ? rateLimits : undefined });
        },
    };
}
