import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { z } from "zod";
import { colors, printOk, printSystem } from "./ui.js";
import { loadProfileSecret, storeProfileSecret } from "./security/secrets.js";
import { clearProfileUsage } from "./usage-store.js";
const CONFIG_DIR = path.join(os.homedir(), ".forge");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");
const profileSchema = z.object({
    baseURL: z.string().url().or(z.string().startsWith("http://")),
    apiKey: z.string().default(""),
    format: z.enum(["openai", "anthropic", "gemini"]),
    model: z.string().min(1),
    kind: z.enum(["remote", "local"]).default("remote"),
    runtime: z.enum(["ollama", "lmstudio", "llamacpp", "openai-compatible"]).optional(),
    subscription: z.object({
        name: z.string().min(1).max(80).optional(),
        tokenLimit: z.number().int().positive().optional(),
        costLimitUsd: z.number().positive().optional(),
        resetAt: z.string().datetime({ offset: true }).optional(),
    }).optional(),
});
const configSchema = z.object({
    schemaVersion: z.literal(5),
    activeProfile: z.string(),
    profiles: z.record(z.string(), profileSchema),
    permissions: z.object({
        mode: z.enum(["read-only", "balanced", "autonomous"]),
        workspaceRoot: z.string(),
    }),
    routing: z.object({
        mode: z.enum(["manual", "auto"]),
        offline: z.boolean(),
        askBeforeCloud: z.boolean(),
    }),
    ui: z.object({ mode: z.enum(["inline", "tui"]), theme: z.string(), mouse: z.boolean() }),
    runtimes: z.record(z.enum(["ollama", "lmstudio", "llamacpp", "openai-compatible"]), z.object({ baseURL: z.string(), executable: z.string().optional(), modelRoots: z.array(z.string()).optional() })),
});
export const DEFAULT_CONFIG = {
    schemaVersion: 5,
    activeProfile: "",
    profiles: {},
    permissions: { mode: "balanced", workspaceRoot: process.cwd() },
    routing: { mode: "manual", offline: false, askBeforeCloud: true },
    ui: { mode: "tui", theme: "flame", mouse: false },
    runtimes: {
        ollama: { baseURL: "http://127.0.0.1:11434/v1", executable: "ollama" },
        lmstudio: { baseURL: "http://127.0.0.1:1234/v1", executable: "lms" },
        llamacpp: { baseURL: "http://127.0.0.1:8080/v1", executable: "llama-server", modelRoots: [] },
        "openai-compatible": { baseURL: "http://127.0.0.1:8000/v1" },
    },
};
export function migrateConfig(raw) {
    if (!raw || typeof raw !== "object")
        return structuredClone(DEFAULT_CONFIG);
    const candidate = raw;
    if (candidate.schemaVersion === 5)
        return configSchema.parse(candidate);
    if (candidate.schemaVersion === 4) {
        return configSchema.parse({ ...candidate, schemaVersion: 5, ui: { ...(candidate.ui ?? {}), mouse: false } });
    }
    if (candidate.schemaVersion === 3) {
        return configSchema.parse({ ...candidate, schemaVersion: 5, ui: { ...(candidate.ui ?? {}), mouse: false } });
    }
    if (candidate.schemaVersion === 2) {
        return configSchema.parse({ ...candidate, schemaVersion: 5, ui: { ...(candidate.ui ?? {}), mode: "tui", mouse: false } });
    }
    const legacyProfiles = (candidate.profiles && typeof candidate.profiles === "object" ? candidate.profiles : {});
    const profiles = {};
    for (const [name, value] of Object.entries(legacyProfiles)) {
        const parsed = profileSchema.safeParse({ ...value, kind: "remote" });
        if (parsed.success)
            profiles[name] = parsed.data;
    }
    return {
        ...structuredClone(DEFAULT_CONFIG),
        activeProfile: typeof candidate.activeProfile === "string" ? candidate.activeProfile : "",
        profiles,
    };
}
export function configExists() {
    return fs.existsSync(CONFIG_PATH);
}
export function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = migrateConfig(JSON.parse(raw));
    let shouldSave = false;
    for (const [name, profile] of Object.entries(config.profiles)) {
        if (profile.subscription?.resetAt && Date.parse(profile.subscription.resetAt) <= Date.now()) {
            try {
                clearProfileUsage(name);
            }
            catch { /* usage reset must not block startup */ }
            delete profile.subscription.resetAt;
            shouldSave = true;
        }
        if (profile.kind !== "remote")
            continue;
        if (profile.apiKey) {
            shouldSave = storeProfileSecret(name, profile.apiKey) || shouldSave;
        }
        else {
            profile.apiKey = loadProfileSecret(name);
        }
    }
    if (shouldSave)
        saveConfig(config);
    return config;
}
export function redactConfigForDisk(cfg) {
    const disk = structuredClone(cfg);
    for (const profile of Object.values(disk.profiles)) {
        if (profile.kind === "remote")
            profile.apiKey = "";
    }
    return disk;
}
export function saveConfig(cfg) {
    if (!fs.existsSync(CONFIG_DIR))
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const disk = structuredClone(cfg);
    for (const [name, profile] of Object.entries(disk.profiles)) {
        if (profile.kind !== "remote" || !profile.apiKey)
            continue;
        if (storeProfileSecret(name, profile.apiKey))
            profile.apiKey = "";
        else
            console.error(`Warning: OS credential storage unavailable; ${name} remains in the protected config file.`);
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configSchema.parse(disk), null, 2), { mode: 0o600 });
    try {
        fs.chmodSync(CONFIG_PATH, 0o600);
    }
    catch {
        // best-effort on platforms without POSIX perms (e.g. Windows)
    }
    if (!fs.existsSync(SESSIONS_DIR))
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}
const PRESETS = {
    "signor": { baseURL: "https://api.code.signor.ai/v1", format: "openai", defaultModel: "gpt-5-mini" },
    "openrouter": { baseURL: "https://openrouter.ai/api/v1", format: "openai", defaultModel: "openrouter/auto" },
};
export async function runSetupWizard() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(colors.accent("\nWelcome to Forge — let's connect your first API provider(s).\n"));
    console.log(colors.dim("Your keys are stored locally only, at " + CONFIG_PATH + "\n"));
    const cfg = structuredClone(DEFAULT_CONFIG);
    let addMore = true;
    let first = true;
    while (addMore) {
        console.log(colors.dim("Presets: 'signor', 'openrouter', or type 'custom' for any other OpenAI/Anthropic/Gemini-compatible API."));
        const choice = (await ask(rl, colors.user("Provider (signor/openrouter/custom): "))).toLowerCase();
        let baseURL;
        let format;
        let defaultModel;
        let profileName;
        if (PRESETS[choice]) {
            profileName = choice;
            baseURL = PRESETS[choice].baseURL;
            format = PRESETS[choice].format;
            defaultModel = PRESETS[choice].defaultModel;
            printSystem(`Using preset: ${choice} (${baseURL})`);
        }
        else {
            profileName = (await ask(rl, colors.user("Name for this profile (e.g. myprovider): "))) || `provider${Object.keys(cfg.profiles).length + 1}`;
            baseURL = await ask(rl, colors.user("Base URL (e.g. https://api.example.com/v1): "));
            const fmtAns = (await ask(rl, colors.user("API format [openai/anthropic/gemini] (default openai): "))).toLowerCase();
            format = (["openai", "anthropic", "gemini"].includes(fmtAns) ? fmtAns : "openai");
            defaultModel = await ask(rl, colors.user("Default model id: "));
        }
        const apiKey = await ask(rl, colors.user(`API key for ${profileName}: `));
        const modelAns = await ask(rl, colors.user(`Default model [${defaultModel}]: `));
        const model = modelAns || defaultModel;
        cfg.profiles[profileName] = { baseURL, apiKey, format, model, kind: "remote" };
        if (first) {
            cfg.activeProfile = profileName;
            first = false;
        }
        printOk(`Saved profile "${profileName}".`);
        const more = (await ask(rl, colors.user("Add another provider? (y/N): "))).toLowerCase();
        addMore = more === "y" || more === "yes";
    }
    rl.close();
    saveConfig(cfg);
    printOk(`Setup complete. Active profile: ${cfg.activeProfile}\n`);
    return cfg;
}
export function getActiveProfile(cfg) {
    const p = cfg.profiles[cfg.activeProfile];
    if (!p)
        throw new Error(`Active profile "${cfg.activeProfile}" not found in config.`);
    return p;
}
