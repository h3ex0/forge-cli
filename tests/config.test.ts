import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, migrateConfig, redactConfigForDisk } from "../src/config.js";

describe("configuration migration", () => {
  it("upgrades a v1 profile without losing its active model", () => {
    const result = migrateConfig({
      activeProfile: "signor",
      profiles: {
        signor: {
          baseURL: "https://example.test/v1",
          apiKey: "secret",
          format: "openai",
          model: "qwen-test",
        },
      },
    });

    expect(result.schemaVersion).toBe(3);
    expect(result.activeProfile).toBe("signor");
    expect(result.profiles.signor).toMatchObject({
      kind: "remote",
      baseURL: "https://example.test/v1",
      model: "qwen-test",
    });
    expect(result.permissions.mode).toBe("balanced");
    expect(result.runtimes.ollama.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(result.ui.mode).toBe("tui");
  });

  it("moves v2 installations to the new TUI-first default", () => {
    const result = migrateConfig({
      ...structuredClone(DEFAULT_CONFIG),
      schemaVersion: 2,
      ui: { mode: "inline", theme: "flame" },
    });
    expect(result.schemaVersion).toBe(3);
    expect(result.ui.mode).toBe("tui");
  });

  it("returns isolated defaults", () => {
    const first = migrateConfig(undefined);
    first.ui.theme = "cool";
    expect(migrateConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("removes remote API keys from the persisted representation", () => {
    const config = migrateConfig({
      activeProfile: "remote",
      profiles: { remote: { baseURL: "https://example.test/v1", apiKey: "top-secret", format: "openai", model: "test" } },
    });
    expect(redactConfigForDisk(config).profiles.remote.apiKey).toBe("");
  });
});
