import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";

vi.mock("../src/providers/models.js", () => ({ fetchModels: vi.fn(async () => []) }));
vi.mock("../src/runtime/service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/runtime/service.js")>();
  return { ...original, listRuntimeSummaries: vi.fn(async () => []) };
});

import { migrateConfig } from "../src/config.js";
import { ForgeTui } from "../src/tui/app.js";

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
    expect(output).toContain("Ctrl+K commands");
  });
});
