import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { colors, printOk, printSystem, printWarn } from "./ui.js";

export type ApiFormat = "openai" | "anthropic" | "gemini";

export interface Profile {
  baseURL: string;
  apiKey: string;
  format: ApiFormat;
  model: string;
}

export interface ForgeConfig {
  activeProfile: string;
  profiles: Record<string, Profile>;
}

const CONFIG_DIR = path.join(os.homedir(), ".forge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): ForgeConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as ForgeConfig;
}

export function saveConfig(cfg: ForgeConfig) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
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

  const cfg: ForgeConfig = { activeProfile: "", profiles: {} };

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

    cfg.profiles[profileName] = { baseURL, apiKey, format, model };
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
