import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ForgeConfig, RuntimeKind } from "../config.js";
import { createRuntimeAdapter } from "./registry.js";

const execFileAsync = promisify(execFile);
const OWNED_PATH = path.join(os.homedir(), ".forge", "owned-runtimes.json");

interface OwnedRuntimeRecord {
  kind: RuntimeKind;
  pid: number;
  startedAt: string;
}

export interface RuntimeStartOptions {
  modelPath?: string;
}

export interface RuntimeLaunchSpec {
  command: string;
  args: string[];
}

function portOf(baseURL: string, fallback: string): string {
  try { return new URL(baseURL).port || fallback; } catch { return fallback; }
}

export function buildRuntimeLaunchSpec(config: ForgeConfig, kind: RuntimeKind, options: RuntimeStartOptions): RuntimeLaunchSpec {
  const settings = config.runtimes[kind];
  if (kind === "ollama") return { command: settings.executable ?? "ollama", args: ["serve"] };
  if (kind === "lmstudio") return { command: settings.executable ?? "lms", args: ["server", "start", "--port", portOf(settings.baseURL, "1234")] };
  if (kind === "llamacpp") {
    if (!options.modelPath) throw new Error("llama.cpp runtime start requires a model path.");
    return {
      command: settings.executable ?? "llama-server",
      args: ["--model", options.modelPath, "--host", "127.0.0.1", "--port", portOf(settings.baseURL, "8080")],
    };
  }
  throw new Error("Generic OpenAI-compatible runtimes are connect-only.");
}

function loadOwned(): Partial<Record<RuntimeKind, OwnedRuntimeRecord>> {
  try { return JSON.parse(fs.readFileSync(OWNED_PATH, "utf-8")) as Partial<Record<RuntimeKind, OwnedRuntimeRecord>>; } catch { return {}; }
}

function saveOwned(records: Partial<Record<RuntimeKind, OwnedRuntimeRecord>>): void {
  fs.mkdirSync(path.dirname(OWNED_PATH), { recursive: true });
  fs.writeFileSync(OWNED_PATH, JSON.stringify(records, null, 2), { mode: 0o600 });
}

export async function startRuntime(config: ForgeConfig, kind: RuntimeKind, options: RuntimeStartOptions = {}): Promise<{ owned: boolean; pid?: number }> {
  const adapter = createRuntimeAdapter(kind, config);
  if ((await adapter.health()).healthy) return { owned: false };
  const spec = buildRuntimeLaunchSpec(config, kind, options);
  const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.unref();
  if (!child.pid) throw new Error(`Failed to start ${kind}.`);
  const records = loadOwned();
  records[kind] = { kind, pid: child.pid, startedAt: new Date().toISOString() };
  saveOwned(records);
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if ((await adapter.health()).healthy) return { owned: true, pid: child.pid };
  }
  try { process.kill(child.pid); } catch { /* already exited */ }
  delete records[kind];
  saveOwned(records);
  throw new Error(`${kind} did not become healthy within 15 seconds.`);
}

export async function stopOwnedRuntime(config: ForgeConfig, kind: RuntimeKind): Promise<void> {
  const records = loadOwned();
  const record = records[kind];
  if (!record) throw new Error(`Forge does not own a running ${kind} process.`);
  if (kind === "lmstudio") {
    await execFileAsync(config.runtimes.lmstudio.executable ?? "lms", ["server", "stop"], { windowsHide: true });
  } else {
    try { process.kill(record.pid); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  delete records[kind];
  saveOwned(records);
}
