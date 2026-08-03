import { describe, expect, it } from "vitest";
import { createLocalProfile, createRuntimeAdapter, parseModelRef } from "../src/runtime/registry.js";
import { migrateConfig } from "../src/config.js";

describe("local runtime registry", () => {
  it("parses runtime-qualified model references", () => {
    expect(parseModelRef("ollama:qwen3:8b")).toEqual({ runtime: "ollama", model: "qwen3:8b" });
  });

  it("creates a keyless OpenAI-compatible Ollama profile", () => {
    expect(createLocalProfile("ollama", "qwen3:8b")).toMatchObject({
      kind: "local",
      runtime: "ollama",
      format: "openai",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      apiKey: "ollama",
    });
  });

  it("provides managed download adapters for supported local runtimes", () => {
    const config = migrateConfig(undefined);
    expect(createRuntimeAdapter("ollama", config).pullModel).toBeTypeOf("function");
    expect(createRuntimeAdapter("lmstudio", config).pullModel).toBeTypeOf("function");
    expect(createRuntimeAdapter("llamacpp", config).pullModel).toBeTypeOf("function");
  });
});
