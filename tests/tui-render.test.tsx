import React from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";

vi.mock("../src/providers/models.js", () => ({ fetchModels: vi.fn(async () => []) }));
vi.mock("../src/runtime/service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/runtime/service.js")>();
  return { ...original, listRuntimeSummaries: vi.fn(async () => []) };
});
vi.mock("../src/providers/index.js", () => ({ createDriver: vi.fn() }));

import { Box, Text } from "ink";
import { migrateConfig } from "../src/config.js";
import { expandPastedBlocks, ForgeTui, MessageBlock, pastePlaceholder } from "../src/tui/app.js";
import { getTheme } from "../src/tui/theme.js";
import { createDriver } from "../src/providers/index.js";
import type { ChatDriver } from "../src/providers/types.js";

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

  it("truncates a long header status line instead of overlapping the FORGE label", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 80, rows: 24, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    // A long profile/model name is entirely plausible in real use and, before
    // this fix, the header's two Text siblings had no flex constraint against
    // each other: the right side rendered at its full natural width instead
    // of truncating, overlapping and partially overwriting "FORGE" on a
    // narrow terminal — a reproducible layout corruption, not a rendering
    // artifact specific to any one terminal emulator.
    const config = migrateConfig({
      activeProfile: "a-very-long-profile-name-for-testing",
      profiles: { "a-very-long-profile-name-for-testing": { baseURL: "https://example.test", apiKey: "", format: "openai", model: "some-really-long-model-identifier-name" } },
    });

    const instance = render(React.createElement(ForgeTui, { config }), { stdout, stderr, stdin, interactive: false, patchConsole: false });
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();

    expect(output).toContain("◆ FORGE");
    expect(output).not.toMatch(/FORGE[^\s│]/);
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

  it("assembles a bracketed paste delivered in many small chunks into a single placeholder", async () => {
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
    // A large real-terminal paste (e.g. Windows Terminal + Ctrl+V) commonly
    // arrives as many separate small stdin chunks rather than one atomic
    // write. Without bracketed-paste assembly this used to fire a separate
    // synchronous re-render per chunk instead of one for the whole paste.
    const content = "y".repeat(5000);
    stdin.write("\x1b[200~");
    for (let index = 0; index < content.length; index += 200) stdin.write(content.slice(index, index + 200));
    stdin.write("\x1b[201~");
    await new Promise((resolve) => setTimeout(resolve, 30));
    instance.unmount();
    await instance.waitUntilExit();

    expect(output).toContain("[Pasted 5,000 chars, 1 line #1]");
    expect(output).not.toContain("#2");
    expect(output).not.toContain(content);
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
          React.createElement(MessageBlock, { message: hugeMessage, theme, maxLines: 10, paneWidth: 90 }),
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

  it("caps a single unbroken long line by its wrapped row count, not its \\n count", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 100, rows: 20, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const theme = getTheme("flame");
    // One logical line (no "\n" at all) that would still wrap into hundreds
    // of terminal rows if rendered whole.
    const oneHugeLine = { role: "user" as const, content: "word ".repeat(4000) };

    const instance = render(
      React.createElement(Box, { flexDirection: "column", height: 20, width: 100 },
        React.createElement(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0, flexDirection: "column", overflow: "hidden" },
          React.createElement(MessageBlock, { message: oneHugeLine, theme, maxLines: 10, paneWidth: 90 }),
        ),
        React.createElement(Box, { borderStyle: "round" }, React.createElement(Text, null, "COMPOSER")),
      ),
      { stdout, stderr, stdin, interactive: false, patchConsole: false },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();

    const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9]*[A-Za-z]/g, "");
    const renderedLines = stripAnsi(output).split("\n").filter((line) => line.length > 0);
    expect(renderedLines.length).toBeLessThanOrEqual(20);
    expect(output).toContain("more line(s)");
    expect(output).toContain("COMPOSER");
  });

  it("batches rapid streaming deltas instead of writing to the terminal once per token", async () => {
    let sendDeltas: ((delta: string) => void) | undefined;
    let finishStream: (() => void) | undefined;
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks) {
        sendDeltas = callbacks.onTextDelta;
        // Resolve only once the test has pushed all the deltas it wants and
        // told us to finish, by awaiting a promise the test controls.
        await new Promise<void>((resolve) => { finishStream = resolve; });
        callbacks.onDone();
      },
    };
    vi.mocked(createDriver).mockReturnValue(driver);

    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdout, { columns: 120, rows: 30, isTTY: false });
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let writeCount = 0;
    stdout.on("data", () => { writeCount += 1; });
    const config = migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });

    const instance = render(React.createElement(ForgeTui, { config }), { stdout, stderr, stdin, interactive: false, patchConsole: false });
    await instance.waitUntilRenderFlush();
    stdin.write("hello");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));

    writeCount = 0;
    // Simulate a fast provider: 100 separate token deltas fired back-to-back,
    // well within a single 50ms batching window.
    for (let index = 0; index < 100; index += 1) sendDeltas?.(`${index} `);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const writesDuringBurst = writeCount;
    finishStream?.();
    await new Promise((resolve) => setTimeout(resolve, 100));

    instance.unmount();
    await instance.waitUntilExit();

    // Ink's own 30fps write throttle already keeps this bounded even without
    // Forge's extra batching; this asserts the combination still holds, i.e.
    // a fast-streaming provider can't flood the terminal with one write per
    // token (a plausible contributor to visible corruption during streaming).
    expect(writesDuringBurst).toBeLessThan(10);
  });

  describe("a huge single-line message loaded into a real session", () => {
    let home: string;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
      process.env.FORGE_HOME = home;
      vi.resetModules();
    });

    afterEach(() => {
      delete process.env.FORGE_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it("keeps the whole workspace layout within the terminal's actual height", async () => {
      const { saveSession } = await import("../src/session.js");
      const { migrateConfig: freshMigrateConfig } = await import("../src/config.js");
      const { ForgeTui: FreshForgeTui } = await import("../src/tui/app.js");

      // One continuous line with no newlines — the case that only a line-count
      // cap (without flexBasis/flexShrink on the row layout) fails to bound.
      saveSession("huge", [{ role: "user", content: "The quick brown fox jumps over the lazy dog. ".repeat(2000) }]);

      const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
      const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
      const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
      Object.assign(stdout, { columns: 130, rows: 30, isTTY: false });
      Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
      let output = "";
      stdout.on("data", (chunk) => { output += chunk.toString(); });
      const config = freshMigrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });

      const instance = render(React.createElement(FreshForgeTui, { config }), { stdout, stderr, stdin, interactive: false, patchConsole: false });
      await instance.waitUntilRenderFlush();
      output = "";
      stdin.write("/load huge");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      instance.unmount();
      await instance.waitUntilExit();

      const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9]*[A-Za-z]/g, "");
      const renderedLines = stripAnsi(output).split("\n").filter((line) => line.length > 0);
      expect(renderedLines.length).toBeLessThanOrEqual(30);
      expect(output).toContain("quick brown fox");
      // The composer must still be fully bordered and visible below the conversation pane.
      expect(output).toMatch(/›/);
    });
  });
});
