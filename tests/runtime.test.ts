import { describe, expect, it, vi } from "vitest";
import { OllamaAdapter } from "../src/runtime/ollama.js";

describe("Ollama runtime adapter", () => {
  it("maps installed models and capabilities", async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:8b", size: 10 }] }));
      if (url.endsWith("/api/show") && init?.method === "POST") {
        return new Response(JSON.stringify({ capabilities: ["completion", "tools", "thinking"], details: { parameter_size: "8B" } }));
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new OllamaAdapter({ request });

    const models = await adapter.listModels();
    expect(models).toEqual([{ id: "qwen3:8b", runtime: "ollama", size: 10 }]);
    expect(await adapter.inspectModel("qwen3:8b")).toMatchObject({ chat: true, tools: true, thinking: true });
  });

  it("reports an unhealthy runtime when the API is unreachable", async () => {
    const adapter = new OllamaAdapter({ request: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(adapter.health()).resolves.toMatchObject({ healthy: false });
  });
});
