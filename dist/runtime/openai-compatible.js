import { EMPTY_CAPABILITIES } from "./types.js";
export class OpenAICompatibleRuntimeAdapter {
    kind;
    baseURL;
    request;
    apiKey;
    assumeTools;
    constructor(options) {
        this.kind = options.kind;
        this.baseURL = options.baseURL.replace(/\/$/, "");
        this.request = options.request ?? fetch;
        this.apiKey = options.apiKey ?? "local";
        this.assumeTools = options.assumeTools ?? false;
    }
    headers() {
        return { Authorization: `Bearer ${this.apiKey}` };
    }
    async health() {
        try {
            const response = await this.request(`${this.baseURL}/models`, { headers: this.headers() });
            return response.ok ? { healthy: true } : { healthy: false, message: `HTTP ${response.status}` };
        }
        catch (error) {
            return { healthy: false, message: error instanceof Error ? error.message : String(error) };
        }
    }
    async listModels() {
        const response = await this.request(`${this.baseURL}/models`, { headers: this.headers() });
        if (!response.ok)
            throw new Error(`${this.kind} model list failed: HTTP ${response.status}`);
        const payload = (await response.json());
        return (payload.data ?? []).map((model) => ({ id: model.id, runtime: this.kind }));
    }
    async inspectModel(_id) {
        return { ...EMPTY_CAPABILITIES, tools: this.assumeTools };
    }
}
