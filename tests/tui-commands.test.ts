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
    expect(executeTuiCommand("/mouse on", value)).toMatchObject({ type: "notice" });
    expect(value.config.ui.mouse).toBe(true);
  });

  it("stages a new provider without ever handling its key as text", () => {
    const value = context();
    expect(executeTuiCommand("/provider add openrouter https://openrouter.ai/api/v1 openai openrouter/auto", value)).toEqual({
      type: "provider-add",
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      format: "openai",
      model: "openrouter/auto",
    });
    expect(value.config.profiles.openrouter).toBeUndefined();
  });

  it("defaults to openai format when none is given", () => {
    const value = context();
    expect(executeTuiCommand("/provider add openrouter https://openrouter.ai/api/v1 openrouter/auto", value)).toEqual({
      type: "provider-add",
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      format: "openai",
      model: "openrouter/auto",
    });
  });

  it("rejects a malformed provider add before any key prompt", () => {
    const value = context();
    expect(executeTuiCommand("/provider add openrouter ftp://bad openai model-id", value)).toMatchObject({ type: "notice", message: expect.stringContaining("http") });
    expect(executeTuiCommand("/provider add openrouter", value)).toMatchObject({ type: "notice", message: expect.stringContaining("Usage:") });
  });

  it("routes key updates to masked entry and refuses inline plaintext keys", () => {
    const value = context();
    expect(executeTuiCommand("/key test", value)).toEqual({ type: "key-update", name: "test" });
    expect(executeTuiCommand("/key test sk-plaintext", value)).toMatchObject({ type: "notice", message: expect.stringContaining("disabled") });
    expect(executeTuiCommand("/key unknown-profile", value)).toMatchObject({ type: "notice", message: expect.stringContaining("Unknown profile") });
  });

  it("configures and clears a context-window warning threshold", () => {
    const value = context();
    expect(executeTuiCommand("/context window nope", value)).toMatchObject({ type: "notice", message: expect.stringContaining("not set") });
    expect(executeTuiCommand("/context window 128000", value)).toMatchObject({ type: "notice", message: expect.stringContaining("128,000") });
    expect(value.config.profiles.test.contextWindowTokens).toBe(128000);
    expect(executeTuiCommand("/context window clear", value)).toMatchObject({ type: "notice" });
    expect(value.config.profiles.test.contextWindowTokens).toBeUndefined();
  });

  it("maps /compact to a dedicated compaction action", () => {
    const value = context();
    expect(executeTuiCommand("/compact", value)).toEqual({ type: "compact" });
  });

  it("maps /undo to a dedicated undo action", () => {
    const value = context();
    expect(executeTuiCommand("/undo", value)).toEqual({ type: "undo" });
  });

  it("builds a subagent delegation prompt, optionally pinned to a provider profile", () => {
    const value = context();
    expect(executeTuiCommand("/agent", value)).toMatchObject({ type: "notice", message: expect.stringContaining("Usage:") });
    expect(executeTuiCommand("/agent research the auth module", value)).toMatchObject({
      type: "prompt",
      prompt: expect.stringContaining("research the auth module"),
    });
    const pinned = executeTuiCommand("/agent test dig into the failing test", value);
    expect(pinned).toMatchObject({ type: "prompt", prompt: expect.stringContaining('profile "test"') });
    expect(pinned).toMatchObject({ prompt: expect.stringContaining("dig into the failing test") });
  });
});
