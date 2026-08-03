import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";
import type { ChatMessage } from "./providers/types.js";

export function validateSessionName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(trimmed) || trimmed.includes("..")) {
    throw new Error("Invalid session name. Use 1-80 letters, numbers, dots, underscores, or hyphens without '..'.");
  }
  return trimmed;
}

export function listSessions(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function saveSession(name: string, messages: ChatMessage[]) {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, `${validateSessionName(name)}.json`);
  fs.writeFileSync(file, JSON.stringify(messages, null, 2), "utf-8");
}

export function loadSession(name: string): ChatMessage[] {
  const file = path.join(SESSIONS_DIR, `${validateSessionName(name)}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export function defaultSessionName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Serialize a conversation as JSON or readable Markdown based on the target extension. */
export function serializeConversation(messages: ChatMessage[], extension: ".json" | ".md"): string {
  if (extension === ".json") return `${JSON.stringify(messages, null, 2)}\n`;
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => `## ${message.role === "assistant" ? "Forge" : message.role === "user" ? "You" : `Tool: ${message.name ?? "result"}`}\n\n${message.content}`)
    .join("\n\n---\n\n") + "\n";
}
