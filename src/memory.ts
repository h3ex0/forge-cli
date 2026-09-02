import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG_DIR } from "./config.js";

export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: string;
}

const MAX_ENTRIES = 200;
const MAX_TEXT = 2_000;

function memoryDir(): string {
  return path.join(CONFIG_DIR, "memory");
}

/**
 * Memory is scoped per workspace: what Forge learned about one project is
 * rarely true of another. The path is hashed so a workspace anywhere on disk
 * maps to one flat file, with a readable prefix to keep the directory
 * browsable by hand.
 */
function memoryFile(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const digest = createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 12);
  return path.join(memoryDir(), `${path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)}-${digest}.json`);
}

export function readMemory(workspaceRoot: string): MemoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(memoryFile(workspaceRoot), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is MemoryEntry =>
      Boolean(entry) && typeof entry === "object"
      && typeof (entry as MemoryEntry).id === "string"
      && typeof (entry as MemoryEntry).text === "string");
  } catch {
    return []; // absent or hand-broken file: start from nothing rather than fail a turn
  }
}

function writeAll(workspaceRoot: string, entries: MemoryEntry[]): void {
  fs.mkdirSync(memoryDir(), { recursive: true });
  fs.writeFileSync(memoryFile(workspaceRoot), JSON.stringify(entries, null, 2), "utf-8");
}

/** Append a fact. Returns the stored entry, or undefined for a duplicate. */
export function rememberFact(workspaceRoot: string, text: string): MemoryEntry | undefined {
  const trimmed = text.trim().slice(0, MAX_TEXT);
  if (!trimmed) throw new Error("Memory text cannot be empty.");
  const entries = readMemory(workspaceRoot);
  if (entries.some((entry) => entry.text === trimmed)) return undefined;
  const entry: MemoryEntry = {
    id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    text: trimmed,
    createdAt: new Date().toISOString(),
  };
  entries.push(entry);
  // Oldest-first eviction: a long-lived workspace shouldn't grow the prompt
  // without bound, and the most recent understanding is the most useful.
  writeAll(workspaceRoot, entries.slice(-MAX_ENTRIES));
  return entry;
}

export function forgetFact(workspaceRoot: string, id: string): boolean {
  const entries = readMemory(workspaceRoot);
  const remaining = entries.filter((entry) => entry.id !== id);
  if (remaining.length === entries.length) return false;
  writeAll(workspaceRoot, remaining);
  return true;
}

export function clearMemory(workspaceRoot: string): void {
  writeAll(workspaceRoot, []);
}

/** Render memory for the system prompt, bounded so it can't dominate context. */
export function memoryPromptSection(workspaceRoot: string, maxChars = 4_000): string {
  const entries = readMemory(workspaceRoot);
  if (!entries.length) return "";
  const lines: string[] = [];
  let used = 0;
  // Newest first: if the budget runs out, the oldest facts are what's dropped.
  for (const entry of [...entries].reverse()) {
    const line = `- ${entry.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return "";
  return `\n\nRemembered about this workspace (from earlier sessions):\n${lines.reverse().join("\n")}`;
}
