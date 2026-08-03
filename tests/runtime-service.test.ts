import { describe, expect, it } from "vitest";
import { migrateConfig } from "../src/config.js";
import { activateLocalModel } from "../src/runtime/service.js";

describe("local model activation", () => {
  it("creates and activates a stable runtime profile", () => {
    const config = migrateConfig(undefined);
    const profileName = activateLocalModel(config, "ollama:qwen3:8b");
    expect(profileName).toBe("local-ollama");
    expect(config.activeProfile).toBe("local-ollama");
    expect(config.profiles[profileName]).toMatchObject({ runtime: "ollama", model: "qwen3:8b", kind: "local" });
  });
});
