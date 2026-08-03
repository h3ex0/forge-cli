import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIDriver } from "../src/providers/openai.js";

afterEach(() => vi.unstubAllGlobals());

describe("provider rate-limit metadata", () => {
  it("captures OpenAI-compatible token and request headers", async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      { headers: {
        "content-type": "text/event-stream",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "900",
        "x-ratelimit-limit-requests": "50",
        "x-ratelimit-remaining-requests": "49",
      } },
    ));
    vi.stubGlobal("fetch", request);
    const done = vi.fn();
    const controller = new AbortController();

    await createOpenAIDriver({ baseURL: "https://example.test/v1", apiKey: "secret" }).streamChat(
      [{ role: "user", content: "hi" }], [], "qwen", {
        onTextDelta: () => undefined,
        onToolCallsComplete: () => undefined,
        onDone: done,
        onError: (error) => { throw error; },
      }, controller.signal,
    );

    expect(request.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 3,
      completionTokens: 1,
      rateLimits: expect.objectContaining({ tokenLimit: 1000, tokenRemaining: 900, requestLimit: 50, requestRemaining: 49 }),
    }));
  });
});
