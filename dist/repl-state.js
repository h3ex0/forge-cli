import { saveConfig } from "./config.js";
import { colors } from "./ui.js";
import fs from "node:fs";
import path from "node:path";
import { loadProjectInstructions } from "./project.js";
import { resolveWorkspacePath } from "./security/workspace.js";
const SYSTEM_PROMPT = "You are Forge, a helpful AI coding and general-purpose assistant running in a local CLI. " +
    "You have access to tools for reading/writing files, searching, running shell commands, and fetching web pages. " +
    "Use tools when they help answer the request accurately. Be concise and direct.";
export class AppState {
    cfg;
    messages;
    reader;
    usage = { promptTokens: 0, completionTokens: 0 };
    pricingCache = new Map();
    contextFiles = new Map();
    projectInstructions;
    pendingPrompt = null;
    constructor(cfg, reader) {
        this.cfg = cfg;
        this.reader = reader;
        this.projectInstructions = loadProjectInstructions(cfg.permissions.workspaceRoot);
        this.messages = [{ role: "system", content: this.systemPrompt() }];
    }
    systemPrompt() {
        const instructions = this.projectInstructions.map((item) => `\n\n[${item.file}]\n${item.content}`).join("");
        return `${SYSTEM_PROMPT} Work only inside the approved workspace unless the user explicitly changes it.${instructions}`;
    }
    resetMessages() {
        this.messages = [{ role: "system", content: this.systemPrompt() }];
    }
    modelMessages() {
        if (!this.contextFiles.size)
            return this.messages;
        const context = Array.from(this.contextFiles, ([file, content]) => `[Pinned file: ${file}]\n${content}`).join("\n\n");
        return [...this.messages, { role: "system", content: `Pinned workspace context:\n${context}` }];
    }
    pinContext(input) {
        const file = resolveWorkspacePath(this.cfg.permissions.workspaceRoot, input);
        if (!fs.statSync(file).isFile())
            throw new Error("Context target must be a file.");
        const relative = path.relative(this.cfg.permissions.workspaceRoot, file);
        this.contextFiles.set(relative, fs.readFileSync(file, "utf-8").slice(0, 48_000));
        return relative;
    }
    setWorkspace(workspace) {
        this.cfg.permissions.workspaceRoot = workspace;
        this.contextFiles.clear();
        this.projectInstructions = loadProjectInstructions(workspace);
        this.resetMessages();
        this.persistConfig();
    }
    persistConfig() {
        saveConfig(this.cfg);
    }
    setActiveProfile(name) {
        this.cfg.activeProfile = name;
        this.persistConfig();
    }
    async ask(question) {
        const line = await this.reader.next(question);
        return (line ?? "").trim();
    }
    async confirm(question) {
        const line = await this.reader.next(colors.warn(`${question} (y/N): `));
        if (line === null)
            return false; // input closed/unavailable — fail safe by denying
        const answer = line.trim().toLowerCase();
        return answer === "y" || answer === "yes";
    }
    async addProviderInteractive() {
        const name = await this.ask(colors.user("Profile name: "));
        if (!name)
            return;
        const baseURL = await this.ask(colors.user("Base URL: "));
        const fmtAns = (await this.ask(colors.user("Format [openai/anthropic/gemini] (default openai): "))).toLowerCase();
        const format = (["openai", "anthropic", "gemini"].includes(fmtAns) ? fmtAns : "openai");
        const apiKey = await this.ask(colors.user("API key: "));
        const model = await this.ask(colors.user("Default model id: "));
        this.cfg.profiles[name] = { baseURL, apiKey, format, model, kind: "remote" };
        this.persistConfig();
    }
}
