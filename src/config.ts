import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { z } from "zod";
import { colors, printOk, printSystem, printWarn } from "./ui.js";
import { loadProfileSecret, storeProfileSecret } from "./security/secrets.js";
import { clearProfileUsage } from "./usage-store.js";

export type ApiFormat = "openai" | "anthropic" | "gemini";
export type ProfileKind = "remote" | "local";
export type RuntimeKind = "ollama" | "lmstudio" | "llamacpp" | "openai-compatible";
export type PermissionMode = "read-only" | "balanced" | "autonomous";
export type RoutingMode = "manual" | "auto";

export interface Profile {
  baseURL: string;
  apiKey: string;
  format: ApiFormat;
  model: string;
  kind: ProfileKind;
  runtime?: RuntimeKind;
  subscription?: {
    name?: string;
    tokenLimit?: number;
    costLimitUsd?: number;
    resetAt?: string;
  };
}

export interface ForgeConfig {
  schemaVersion: 3;
  activeProfile: string;
  profiles: Record<string, Profile>;
  permissions: { mode: PermissionMode; workspaceRoot: string };
  routing: { mode: RoutingMode; offline: boolean; askBeforeCloud: boolean };
  ui: { mode: "inline" | "tui"; theme: string };
  runtimes: Record<RuntimeKind, { baseURL: string; executable?: string; modelRoots?: string[] }>;
}

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
  schemaVersion: z.literal(3),
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
  ui: z.object({ mode: z.enum(["inline", "tui"]), theme: z.string() }),
  runtimes: z.record(
    z.enum(["ollama", "lmstudio", "llamacpp", "openai-compatible"]),
    z.object({ baseURL: z.string(), executable: z.string().optional(), modelRoots: z.array(z.string()).optional() }),
  ),
});

export const DEFAULT_CONFIG: ForgeConfig = {
  schemaVersion: 3,
  activeProfile: "",
  profiles: {},
  permissions: { mode: "balanced", workspaceRoot: process.cwd() },
  routing: { mode: "manual", offline: false, askBeforeCloud: true },
  ui: { mode: "tui", theme: "flame" },
  runtimes: {
    ollama: { baseURL: "http://127.0.0.1:11434/v1", executable: "ollama" },
    lmstudio: { baseURL: "http://127.0.0.1:1234/v1", executable: "lms" },
    llamacpp: { baseURL: "http://127.0.0.1:8080/v1", executable: "llama-server", modelRoots: [] },
    "openai-compatible": { baseURL: "http://127.0.0.1:8000/v1" },
  },
};

export function migrateConfig(raw: unknown): ForgeConfig {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_CONFIG);
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion === 3) return configSchema.parse(candidate);

  if (candidate.schemaVersion === 2) {
    return configSchema.parse({ ...candidate, schemaVersion: 3, ui: { ...((candidate.ui as object | undefined) ?? {}), mode: "tui" } });
  }

  const legacyProfiles = (candidate.profiles && typeof candidate.profiles === "object" ? candidate.profiles : {}) as Record<string, unknown>;
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(legacyProfiles)) {
    const parsed = profileSchema.safeParse({ ...(value as object), kind: "remote" });
    if (parsed.success) profiles[name] = parsed.data;
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    activeProfile: typeof candidate.activeProfile === "string" ? candidate.activeProfile : "",
    profiles,
  };
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): ForgeConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = migrateConfig(JSON.parse(raw));
  let shouldSave = false;
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.subscription?.resetAt && Date.parse(profile.subscription.resetAt) <= Date.now()) {
      try { clearProfileUsage(name); } catch { /* usage reset must not block startup */ }
      delete profile.subscription.resetAt;
      shouldSave = true;
    }
    if (profile.kind !== "remote") continue;
    if (profile.apiKey) {
      shouldSave = storeProfileSecret(name, profile.apiKey) || shouldSave;
    } else {
      profile.apiKey = loadProfileSecret(name);
    }
  }
  if (shouldSave) saveConfig(config);
  return config;
}

export function redactConfigForDisk(cfg: ForgeConfig): ForgeConfig {
  const disk = structuredClone(cfg);
  for (const profile of Object.values(disk.profiles)) {
    if (profile.kind === "remote") profile.apiKey = "";
  }
  return disk;
}

export function saveConfig(cfg: ForgeConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const disk = structuredClone(cfg);
  for (const [name, profile] of Object.entries(disk.profiles)) {
    if (profile.kind !== "remote" || !profile.apiKey) continue;
    if (storeProfileSecret(name, profile.apiKey)) profile.apiKey = "";
    else console.error(`Warning: OS credential storage unavailable; ${name} remains in the protected config file.`);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configSchema.parse(disk), null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // best-effort on platforms without POSIX perms (e.g. Windows)
  }
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

const PRESETS: Record<string, { baseURL: string; format: ApiFormat; defaultModel: string }> = {
  "signor": { baseURL: "https://api.code.signor.ai/v1", format: "openai", defaultModel: "gpt-5-mini" },
  "openrouter": { baseURL: "https://openrouter.ai/api/v1", format: "openai", defaultModel: "openrouter/auto" },
};

export async function runSetupWizard(): Promise<ForgeConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(colors.accent("\nWelcome to Forge — let's connect your first API provider(s).\n"));
  console.log(colors.dim("Your keys are stored locally only, at " + CONFIG_PATH + "\n"));

  const cfg: ForgeConfig = structuredClone(DEFAULT_CONFIG);

  let addMore = true;
  let first = true;
  while (addMore) {
    console.log(colors.dim("Presets: 'signor', 'openrouter', or type 'custom' for any other OpenAI/Anthropic/Gemini-compatible API."));
    const choice = (await ask(rl, colors.user("Provider (signor/openrouter/custom): "))).toLowerCase();

    let baseURL: string;
    let format: ApiFormat;
    let defaultModel: string;
    let profileName: string;

    if (PRESETS[choice]) {
      profileName = choice;
      baseURL = PRESETS[choice].baseURL;
      format = PRESETS[choice].format;
      defaultModel = PRESETS[choice].defaultModel;
      printSystem(`Using preset: ${choice} (${baseURL})`);
    } else {
      profileName = (await ask(rl, colors.user("Name for this profile (e.g. myprovider): "))) || `provider${Object.keys(cfg.profiles).length + 1}`;
      baseURL = await ask(rl, colors.user("Base URL (e.g. https://api.example.com/v1): "));
      const fmtAns = (await ask(rl, colors.user("API format [openai/anthropic/gemini] (default openai): "))).toLowerCase();
      format = (["openai", "anthropic", "gemini"].includes(fmtAns) ? fmtAns : "openai") as ApiFormat;
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

export function getActiveProfile(cfg: ForgeConfig): Profile {
  const p = cfg.profiles[cfg.activeProfile];
  if (!p) throw new Error(`Active profile "${cfg.activeProfile}" not found in config.`);
  return p;
}
