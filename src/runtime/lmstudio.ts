import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OpenAICompatibleRuntimeAdapter } from "./openai-compatible.js";
import type { PullProgress } from "./types.js";

const execFileAsync = promisify(execFile);

export class LmStudioAdapter extends OpenAICompatibleRuntimeAdapter {
  private readonly executable: string;

  constructor(options: { baseURL: string; executable?: string; request?: typeof fetch }) {
    super({ kind: "lmstudio", baseURL: options.baseURL, request: options.request });
    this.executable = options.executable ?? "lms";
  }

  async *pullModel(id: string, signal?: AbortSignal): AsyncIterable<PullProgress> {
    yield { status: `Downloading ${id} with LM Studio` };
    await execFileAsync(this.executable, ["get", id], { signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    yield { status: "success" };
  }
}
