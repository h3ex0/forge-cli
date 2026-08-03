import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { validatePublicUrl } from "../security/network.js";
import { OpenAICompatibleRuntimeAdapter } from "./openai-compatible.js";
import type { PullProgress } from "./types.js";

export class LlamaCppAdapter extends OpenAICompatibleRuntimeAdapter {
  private readonly modelsDirectory: string;

  constructor(options: { baseURL: string; modelsDirectory?: string; request?: typeof fetch }) {
    super({ kind: "llamacpp", baseURL: options.baseURL, request: options.request, assumeTools: true });
    this.modelsDirectory = options.modelsDirectory ?? path.join(os.homedir(), ".forge", "models", "llamacpp");
  }

  async *pullModel(id: string, signal?: AbortSignal): AsyncIterable<PullProgress> {
    const url = await validatePublicUrl(id);
    const filename = path.basename(decodeURIComponent(url.pathname));
    if (!filename.toLowerCase().endsWith(".gguf")) throw new Error("llama.cpp downloads require an explicit .gguf URL.");
    fs.mkdirSync(this.modelsDirectory, { recursive: true });
    const destination = path.join(this.modelsDirectory, filename);
    const temporary = `${destination}.partial`;
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`GGUF download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length")) || undefined;
    yield { status: `Downloading ${filename}`, completed: 0, total };
    try {
      await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(temporary), { signal });
      fs.renameSync(temporary, destination);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    yield { status: `Saved ${destination}`, completed: total, total };
  }
}
