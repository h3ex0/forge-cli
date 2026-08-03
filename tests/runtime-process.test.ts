import { describe, expect, it } from "vitest";
import { migrateConfig } from "../src/config.js";
import { buildRuntimeLaunchSpec } from "../src/runtime/process.js";

describe("runtime launch specifications", () => {
  const config = migrateConfig(undefined);

  it("launches Ollama and LM Studio without a shell", () => {
    expect(buildRuntimeLaunchSpec(config, "ollama", {})).toEqual({ command: "ollama", args: ["serve"] });
    expect(buildRuntimeLaunchSpec(config, "lmstudio", {})).toEqual({ command: "lms", args: ["server", "start", "--port", "1234"] });
  });

  it("requires an explicit GGUF path for llama.cpp", () => {
    expect(() => buildRuntimeLaunchSpec(config, "llamacpp", {})).toThrow(/model path/i);
    expect(buildRuntimeLaunchSpec(config, "llamacpp", { modelPath: "C:/models/qwen.gguf" })).toMatchObject({
      command: "llama-server",
      args: ["--model", "C:/models/qwen.gguf", "--host", "127.0.0.1", "--port", "8080"],
    });
  });
});
