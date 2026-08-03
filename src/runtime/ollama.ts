import type { LocalModel, ModelCapabilities, PullProgress, RuntimeAdapter, RuntimeHealth } from "./types.js";

export interface OllamaAdapterOptions {
  baseURL?: string;
  request?: typeof fetch;
}

export class OllamaAdapter implements RuntimeAdapter {
  readonly kind = "ollama" as const;
  private readonly baseURL: string;
  private readonly request: typeof fetch;

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseURL = (options.baseURL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.request = options.request ?? fetch;
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const response = await this.request(`${this.baseURL}/api/tags`);
      return response.ok ? { healthy: true } : { healthy: false, message: `HTTP ${response.status}` };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listModels(): Promise<LocalModel[]> {
    const response = await this.request(`${this.baseURL}/api/tags`);
    if (!response.ok) throw new Error(`Ollama model list failed: HTTP ${response.status}`);
    const payload = (await response.json()) as { models?: Array<{ name: string; size?: number }> };
    return (payload.models ?? []).map((model) => ({ id: model.name, runtime: this.kind, size: model.size }));
  }

  async inspectModel(id: string): Promise<ModelCapabilities> {
    const response = await this.request(`${this.baseURL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
    });
    if (!response.ok) throw new Error(`Ollama model inspection failed: HTTP ${response.status}`);
    const payload = (await response.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
    const capabilities = new Set(payload.capabilities ?? []);
    return {
      chat: capabilities.has("completion"),
      tools: capabilities.has("tools"),
      thinking: capabilities.has("thinking"),
      vision: capabilities.has("vision"),
      audio: capabilities.has("audio"),
      embeddings: capabilities.has("embedding") || capabilities.has("embeddings"),
    };
  }

  async *pullModel(id: string, signal?: AbortSignal): AsyncIterable<PullProgress> {
    const response = await this.request(`${this.baseURL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: id, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Ollama pull failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        yield JSON.parse(line) as PullProgress;
      }
    }
  }
}
