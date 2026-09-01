import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/providers/index.js", () => ({ createDriver: vi.fn() }));
vi.mock("../src/tools/index.js", () => ({ createTools: vi.fn() }));

import { AgentSession } from "../src/agent/session.js";
import { migrateConfig } from "../src/config.js";
import { createDriver } from "../src/providers/index.js";
import { createTools } from "../src/tools/index.js";
import type { ChatDriver, ChatMessage } from "../src/providers/types.js";
import type { ToolSpec } from "../src/tools/index.js";

function config() {
  return migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });
}

describe("AgentSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams a response and accumulates usage", async () => {
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks) {
        callbacks.onTextDelta("hello");
        callbacks.onDone({ promptTokens: 10, completionTokens: 4, rateLimits: { tokenRemaining: 900 } });
      },
    };
    vi.mocked(createDriver).mockReturnValue(driver);
    vi.mocked(createTools).mockReturnValue([]);
    const messages: ChatMessage[] = [{ role: "system", content: "system" }];
    const session = new AgentSession({ config: config(), messages, approve: async () => false, recordUsage: () => undefined });
    const eventTypes: string[] = [];
    session.subscribe((event) => eventTypes.push(event.type));

    await session.send("hi");

    expect(messages.at(-1)).toEqual({ role: "assistant", content: "hello" });
    expect(session.usage).toMatchObject({ promptTokens: 10, completionTokens: 4, rateLimits: { tokenRemaining: 900 } });
    expect(eventTypes).toEqual(expect.arrayContaining(["turn.started", "text.delta", "usage.updated", "turn.completed"]));
  });

  it("gates a write tool through approval and returns its result to the model", async () => {
    let calls = 0;
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks) {
        calls += 1;
        if (calls === 1) callbacks.onToolCallsComplete([{ id: "1", name: "write_file", arguments: "{\"path\":\"a.txt\"}" }]);
        else callbacks.onTextDelta("done");
        callbacks.onDone();
      },
    };
    const execute = vi.fn(async () => "wrote file");
    const spec = { def: { name: "write_file", description: "write", parameters: {} }, risk: "write", destructive: true, execute } satisfies ToolSpec;
    vi.mocked(createDriver).mockReturnValue(driver);
    vi.mocked(createTools).mockReturnValue([spec]);
    const approve = vi.fn(async () => true);
    const messages: ChatMessage[] = [{ role: "system", content: "system" }];
    const session = new AgentSession({ config: config(), messages, approve, recordUsage: () => undefined });

    await session.send("edit");

    expect(approve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(messages).toContainEqual(expect.objectContaining({ role: "tool", content: "wrote file", name: "write_file" }));
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "done" });
  });

  it("attaches a tool's diff preview to the approval request", async () => {
    let calls = 0;
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks) {
        calls += 1;
        if (calls === 1) callbacks.onToolCallsComplete([{ id: "1", name: "write_file", arguments: "{\"path\":\"a.txt\"}" }]);
        else callbacks.onTextDelta("done");
        callbacks.onDone();
      },
    };
    const spec = {
      def: { name: "write_file", description: "write", parameters: {} },
      risk: "write",
      destructive: true,
      execute: vi.fn(async () => "wrote file"),
      preview: vi.fn(() => "+added line"),
    } satisfies ToolSpec;
    vi.mocked(createDriver).mockReturnValue(driver);
    vi.mocked(createTools).mockReturnValue([spec]);
    let seenDiff: string | undefined;
    const approve = vi.fn(async (request) => { seenDiff = request.activity.diff; return true; });
    const session = new AgentSession({ config: config(), messages: [{ role: "system", content: "system" }], approve, recordUsage: () => undefined });

    await session.send("edit");

    expect(spec.preview).toHaveBeenCalledOnce();
    expect(seenDiff).toBe("+added line");
  });

  it("delegates to a subagent via spawn_agent and folds its report and usage back in", async () => {
    let call = 0;
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks) {
        call += 1;
        if (call === 1) {
          callbacks.onToolCallsComplete([{ id: "1", name: "spawn_agent", arguments: JSON.stringify({ task: "research X" }) }]);
          callbacks.onDone({ promptTokens: 5, completionTokens: 1 });
        } else if (call === 2) {
          callbacks.onTextDelta("sub result");
          callbacks.onDone({ promptTokens: 3, completionTokens: 2 });
        } else {
          callbacks.onTextDelta("done");
          callbacks.onDone({ promptTokens: 1, completionTokens: 1 });
        }
      },
    };
    vi.mocked(createDriver).mockReturnValue(driver);
    vi.mocked(createTools).mockReturnValue([]);
    const approve = vi.fn(async () => true);
    const messages: ChatMessage[] = [{ role: "system", content: "system" }];
    const session = new AgentSession({ config: config(), messages, approve, recordUsage: () => undefined });

    await session.send("delegate this");

    expect(approve).toHaveBeenCalledOnce();
    expect(messages).toContainEqual(expect.objectContaining({ role: "tool", name: "spawn_agent", content: "sub result" }));
    expect(session.usage).toMatchObject({ promptTokens: 9, completionTokens: 4 });
  });

  it("refuses to spawn a subagent for an unknown provider profile", async () => {
    let call = 0;
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks) {
        call += 1;
        if (call === 1) callbacks.onToolCallsComplete([{ id: "1", name: "spawn_agent", arguments: JSON.stringify({ task: "x", profile: "ghost" }) }]);
        else callbacks.onTextDelta("done");
        callbacks.onDone();
      },
    };
    vi.mocked(createDriver).mockReturnValue(driver);
    vi.mocked(createTools).mockReturnValue([]);
    const messages: ChatMessage[] = [{ role: "system", content: "system" }];
    const session = new AgentSession({ config: config(), messages, approve: async () => true, recordUsage: () => undefined });

    await session.send("delegate this");

    expect(messages).toContainEqual(expect.objectContaining({ role: "tool", name: "spawn_agent", content: expect.stringContaining("Unknown provider profile") }));
  });

  it("cancels an active provider request", async () => {
    const driver: ChatDriver = {
      async streamChat(_messages, _tools, _model, callbacks, signal) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => {
          callbacks.onError(new Error("aborted"));
          resolve();
        }, { once: true }));
      },
    };
    vi.mocked(createDriver).mockReturnValue(driver);
    vi.mocked(createTools).mockReturnValue([]);
    const session = new AgentSession({ config: config(), messages: [], approve: async () => false, recordUsage: () => undefined });
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    const turn = session.send("wait");
    session.cancel();
    await turn;
    expect(events).toContain("turn.cancelled");
    expect(session.busy).toBe(false);
  });
});
