import { OllamaAdapter } from "./ollama.js";
import { OpenAICompatibleRuntimeAdapter } from "./openai-compatible.js";
import { LmStudioAdapter } from "./lmstudio.js";
import { LlamaCppAdapter } from "./llamacpp.js";
const DEFAULT_ENDPOINTS = {
    ollama: "http://127.0.0.1:11434/v1",
    lmstudio: "http://127.0.0.1:1234/v1",
    llamacpp: "http://127.0.0.1:8080/v1",
    "openai-compatible": "http://127.0.0.1:8000/v1",
};
export function parseModelRef(value) {
    const separator = value.indexOf(":");
    if (separator < 1)
        throw new Error("Model reference must use <runtime>:<model>.");
    const runtime = value.slice(0, separator);
    if (!(runtime in DEFAULT_ENDPOINTS))
        throw new Error(`Unknown local runtime: ${runtime}`);
    const model = value.slice(separator + 1);
    if (!model)
        throw new Error("Model id cannot be empty.");
    return { runtime, model };
}
export function createLocalProfile(runtime, model, baseURL = DEFAULT_ENDPOINTS[runtime]) {
    return {
        kind: "local",
        runtime,
        baseURL,
        apiKey: runtime === "ollama" ? "ollama" : "local",
        format: "openai",
        model,
    };
}
export function createRuntimeAdapter(kind, config) {
    const settings = config.runtimes[kind];
    if (kind === "ollama") {
        const nativeURL = settings.baseURL.replace(/\/v1\/?$/, "");
        return new OllamaAdapter({ baseURL: nativeURL });
    }
    if (kind === "lmstudio")
        return new LmStudioAdapter({ baseURL: settings.baseURL, executable: settings.executable });
    if (kind === "llamacpp")
        return new LlamaCppAdapter({
            baseURL: settings.baseURL,
            modelsDirectory: settings.modelRoots?.[0],
        });
    return new OpenAICompatibleRuntimeAdapter({
        kind,
        baseURL: settings.baseURL,
    });
}
export function runtimeKinds() {
    return ["ollama", "lmstudio", "llamacpp", "openai-compatible"];
}
