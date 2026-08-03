import type { LocalModel, ModelCapabilities, RuntimeAdapter, RuntimeHealth, RuntimeKind } from "./types.js";
import { EMPTY_CAPABILITIES } from "./types.js";

export interface OpenAICompatibleAdapterOptions {
  kind: RuntimeKind;
  baseURL: string;
  apiKey?: string;
  request?: typeof fetch;
  assumeTools?: boolean;
}

export class OpenAICompatibleRuntimeAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind;
  protected readonly baseURL: string;
  protected readonly request: typeof fetch;
  private readonly apiKey: string;
  private readonly assumeTools: boolean;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.kind = options.kind;
    this.baseURL = options.baseURL.replace(/\/$/, "");
    this.request = options.request ?? fetch;
    this.apiKey = options.apiKey ?? "local";
    this.assumeTools = options.assumeTools ?? false;
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const response = await this.request(`${this.baseURL}/models`, { headers: this.headers() });
      return response.ok ? { healthy: true } : { healthy: false, message: `HTTP ${response.status}` };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listModels(): Promise<LocalModel[]> {
    const response = await this.request(`${this.baseURL}/models`, { headers: this.headers() });
    if (!response.ok) throw new Error(`${this.kind} model list failed: HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: Array<{ id: string }> };
    return (payload.data ?? []).map((model) => ({ id: model.id, runtime: this.kind }));
  }

  async inspectModel(_id: string): Promise<ModelCapabilities> {
    return { ...EMPTY_CAPABILITIES, tools: this.assumeTools };
  }
}
