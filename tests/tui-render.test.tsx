import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";

vi.mock("../src/providers/models.js", () => ({ fetchModels: vi.fn(async () => []) }));
vi.mock("../src/runtime/service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/runtime/service.js")>();
  return { ...original, listRuntimeSummaries: vi.fn(async () => []) };
});

import { Box, Text } from "ink";
import { migrateConfig } from "../src/config.js";
import { expandPastedBlocks, ForgeTui, MessageBlock, pastePlaceholder } from "../src/tui/app.js";
import { getTheme } from "../src/tui/theme.js";

describe("Forge TUI rendering", () => {
  it("renders the workspace shell and token status without a provider call", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 120, rows: 30, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const config = migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });

    const instance = render(React.createElement(ForgeTui, { config }), { stdout, stderr, stdin, interactive: false, patchConsole: false });
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();

    expect(output).toContain("FORGE");
    expect(output).toContain("tokens 0");
    expect(output).toContain("[Cmd ^K]");
    expect(output).toContain("[Mouse off ^T]");
    expect(output).toContain("[Reader ^Y]");
    expect(output).toContain("[Status ^E]");
    expect(output).toContain("[Mode ^A]");
  });

  it("cycles the permission mode with Ctrl+A", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 120, rows: 30, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const config = migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });
    expect(config.permissions.mode).toBe("balanced");

    const instance = render(React.createElement(ForgeTui, { config }), { stdout, stderr, stdin, interactive: false, patchConsole: false });
    await instance.waitUntilRenderFlush();
    output = "";
    stdin.write("\u0001"); // Ctrl+A
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    await instance.waitUntilExit();

    expect(output).toContain("· autonomous");
  });

  it("collapses a large paste into a placeholder instead of rendering it inline", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 120, rows: 30, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const config = migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });

    const instance = render(React.createElement(ForgeTui, { config }), { stdout, stderr, stdin, interactive: false, patchConsole: false });
    await instance.waitUntilRenderFlush();
    output = "";
    const hugePaste = "x".repeat(5000);
    stdin.write(hugePaste);
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    await instance.waitUntilExit();

    expect(output).toContain("[Pasted 5,000 chars, 1 line #1]");
    expect(output).not.toContain(hugePaste);
  });

  it("expands paste placeholders back to their full content before sending", () => {
    const blocks = new Map<string, string>();
    const content = "line one\nline two\nline three";
    const token = pastePlaceholder(1, content);
    blocks.set(token, content);

    expect(expandPastedBlocks(`Please review: ${token}`, blocks)).toBe(`Please review: ${content}`);
    expect(expandPastedBlocks("no placeholder here", blocks)).toBe("no placeholder here");
  });

  it("caps a single message's rendered lines instead of letting it overflow the pane", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 100, rows: 20, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const theme = getTheme("flame");
    const hugeMessage = { role: "user" as const, content: Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") };

    const instance = render(
      React.createElement(Box, { flexDirection: "column", height: 20, width: 100 },
        React.createElement(Box, { flexGrow: 1, flexDirection: "column", overflow: "hidden" },
          React.createElement(MessageBlock, { message: hugeMessage, theme, maxLines: 10 }),
        ),
        React.createElement(Box, { borderStyle: "round" }, React.createElement(Text, null, "COMPOSER")),
      ),
      { stdout, stderr, stdin, interactive: false, patchConsole: false },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();

    expect(output).toContain("line 0");
    expect(output).toContain("line 9");
    expect(output).not.toContain("line 299");
    expect(output).toContain("more line(s)");
    expect(output).toContain("COMPOSER");
  });
});
