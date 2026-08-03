import { createOpenAIDriver } from "./openai.js";
import { createAnthropicDriver } from "./anthropic.js";
import { createGeminiDriver } from "./gemini.js";
export function createDriver(profile) {
    switch (profile.format) {
        case "anthropic":
            return createAnthropicDriver(profile);
        case "gemini":
            return createGeminiDriver(profile);
        case "openai":
        default:
            return createOpenAIDriver(profile);
    }
}
export * from "./types.js";
