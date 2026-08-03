import type { ForgeConfig } from "./config.js";
import { saveConfig } from "./config.js";
import type { ChatMessage } from "./providers/types.js";
import { colors } from "./ui.js";
import type { LineSource } from "./line-source.js";
import type { ModelInfo } from "./providers/models.js";

const SYSTEM_PROMPT =
  "You are Forge, a helpful AI coding and general-purpose assistant running in a local CLI. " +
  "You have access to tools for reading/writing files, searching, running shell commands, and fetching web pages. " +
  "Use tools when they help answer the request accurately. Be concise and direct.";

export class AppState {
  cfg: ForgeConfig;
  messages: ChatMessage[];
  reader: LineSource;
  usage = { promptTokens: 0, completionTokens: 0 };
  pricingCache = new Map<string, ModelInfo>();

  constructor(cfg: ForgeConfig, reader: LineSource) {
    this.cfg = cfg;
    this.reader = reader;
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  resetMessages() {
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  persistConfig() {
    saveConfig(this.cfg);
  }

  setActiveProfile(name: string) {
    this.cfg.activeProfile = name;
    this.persistConfig();
  }

  async ask(question: string): Promise<string> {
    const line = await this.reader.next(question);
    return (line ?? "").trim();
  }

  async confirm(question: string): Promise<boolean> {
    const line = await this.reader.next(colors.warn(`${question} (y/N): `));
    if (line === null) return false; // input closed/unavailable — fail safe by denying
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  async addProviderInteractive() {
    const name = await this.ask(colors.user("Profile name: "));
    if (!name) return;
    const baseURL = await this.ask(colors.user("Base URL: "));
    const fmtAns = (await this.ask(colors.user("Format [openai/anthropic/gemini] (default openai): "))).toLowerCase();
    const format = (["openai", "anthropic", "gemini"].includes(fmtAns) ? fmtAns : "openai") as
      | "openai"
      | "anthropic"
      | "gemini";
    const apiKey = await this.ask(colors.user("API key: "));
    const model = await this.ask(colors.user("Default model id: "));
    this.cfg.profiles[name] = { baseURL, apiKey, format, model };
    this.persistConfig();
  }
}
