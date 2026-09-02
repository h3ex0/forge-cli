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

export interface SessionSummary {
  /** Stable identifier, also the file name. */
  id: string;
  /** First line of the first user message, for recognising the session later. */
  title: string;
  updatedAt: string;
  messageCount: number;
}

export function listSessions(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** Derive a human-recognisable title from the first thing the user asked. */
export function sessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return "(empty session)";
  const line = firstUser.content.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line || "(empty session)";
}

/** Sessions newest first, with enough detail to pick one out of a list. */
export function listSessionSummaries(): SessionSummary[] {
  return listSessions()
    .map((id) => {
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      try {
        const messages = JSON.parse(fs.readFileSync(file, "utf-8")) as ChatMessage[];
        return {
          id,
          title: sessionTitle(messages),
          updatedAt: fs.statSync(file).mtime.toISOString(),
          messageCount: messages.filter((message) => message.role !== "system").length,
        };
      } catch {
        return undefined; // unreadable or hand-edited file — skip rather than fail the list
      }
    })
    .filter((entry): entry is SessionSummary => entry !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

export function deleteSession(name: string): void {
  fs.rmSync(path.join(SESSIONS_DIR, `${validateSessionName(name)}.json`), { force: true });
}

/**
 * Identifier for a brand new session. Time-ordered so the id itself sorts
 * chronologically, with a short random suffix so two sessions started in the
 * same second can't collide.
 */
export function newSessionId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `s${stamp}-${Math.random().toString(36).slice(2, 6)}`;
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
