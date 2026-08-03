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

  it("maps workspace navigation commands to bounded tools", () => {
    const value = context();
    expect(executeTuiCommand("/read README.md 2:8", value)).toEqual({
      type: "tool",
      name: "read_file",
      args: { path: "README.md", startLine: 2, endLine: 8 },
    });
    expect(executeTuiCommand("/search TODO src/**/*.ts", value)).toMatchObject({ type: "tool", name: "grep_search" });
    expect(executeTuiCommand("/changed", value)).toEqual({ type: "tool", name: "git_status", args: { args: ["--short"] } });
  });

  it("creates workflow prompts and structured processes", () => {
    const value = context();
    expect(executeTuiCommand("/security src", value)).toMatchObject({ type: "prompt", prompt: expect.stringContaining("src") });
    expect(executeTuiCommand("/run node --version", value)).toEqual({ type: "tool", name: "run_command", args: { command: "node", args: ["--version"] } });
    expect(executeTuiCommand("/check", value)).toMatchObject({ type: "tool-sequence" });
  });

  it("exports conversations through the workspace write tool", () => {
    const value = context();
    value.messages.push({ role: "user", content: "hello" });
    expect(executeTuiCommand("/export notes.md", value)).toMatchObject({
      type: "tool",
      name: "write_file",
      args: { path: "notes.md", content: expect.stringContaining("## You") },
    });
  });

  it("maps the extended tool pack and persists mouse preference", () => {
    const value = context();
    expect(executeTuiCommand("/inspect package.json", value)).toMatchObject({ type: "tool", name: "file_info" });
    expect(executeTuiCommand("/json package.json /scripts/test", value)).toMatchObject({ type: "tool", name: "json_query" });
    expect(executeTuiCommand("/copy a.txt b.txt", value)).toMatchObject({ type: "tool", name: "copy_file" });
    expect(executeTuiCommand("/mouse off", value)).toMatchObject({ type: "notice" });
    expect(value.config.ui.mouse).toBe(false);
  });
});
