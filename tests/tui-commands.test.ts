import { describe, expect, it } from "vitest";
import { migrateConfig } from "../src/config.js";
import { executeTuiCommand, tuiCommandSuggestions } from "../src/tui/commands.js";

function context() {
  const config = migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });
  return { config, messages: [], contextFiles: new Map<string, string>(), setWorkspace: () => undefined, persist: () => undefined };
}

describe("TUI commands", () => {
  it("offers slash-command suggestions", () => {
    expect(tuiCommandSuggestions("/li")).toContain("/limit");
  });

  it("changes permission mode through the shared configuration", () => {
    const value = context();
    expect(executeTuiCommand("/mode read-only", value)).toMatchObject({ type: "notice" });
    expect(value.config.permissions.mode).toBe("read-only");
  });

  it("validates configured subscription limits", () => {
    const value = context();
    expect(executeTuiCommand("/limit set nope", value)).toMatchObject({ type: "notice", message: expect.stringContaining("Usage:") });
  });
});
