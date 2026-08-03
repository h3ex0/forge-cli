import { describe, expect, it } from "vitest";
import { selectModel } from "../src/routing.js";
import type { ModelCandidate } from "../src/runtime/types.js";

const candidates: ModelCandidate[] = [
  { ref: "ollama:qwen3", local: true, healthy: true, capabilities: ["chat", "tools"] },
  { ref: "cloud:gpt", local: false, healthy: true, capabilities: ["chat", "tools", "vision"] },
];

describe("model routing", () => {
  it("uses a pinned model when it satisfies requirements", () => {
    expect(selectModel(candidates, { mode: "manual", pinned: "ollama:qwen3", required: ["tools"] })?.ref).toBe("ollama:qwen3");
  });

  it("keeps offline work local", () => {
    expect(selectModel(candidates, { mode: "auto", offline: true, required: ["chat"] })?.local).toBe(true);
  });

  it("returns a cloud candidate requiring disclosure when only cloud has a capability", () => {
    const selected = selectModel(candidates, { mode: "auto", required: ["vision"] });
    expect(selected).toMatchObject({ ref: "cloud:gpt", requiresCloudApproval: true });
  });
});
