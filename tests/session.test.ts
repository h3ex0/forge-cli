import { describe, expect, it } from "vitest";
import { serializeConversation, validateSessionName } from "../src/session.js";

describe("session names", () => {
  it("accepts readable safe names", () => {
    expect(validateSessionName("qwen-refactor_01")).toBe("qwen-refactor_01");
  });

  it("rejects traversal and separators", () => {
    expect(() => validateSessionName("../secrets")).toThrow(/session name/i);
    expect(() => validateSessionName("nested/name")).toThrow(/session name/i);
  });
});

describe("conversation export", () => {
  const messages = [
    { role: "system" as const, content: "private setup" },
    { role: "user" as const, content: "Explain this" },
    { role: "assistant" as const, content: "Here is the explanation" },
  ];

  it("creates readable Markdown without system instructions", () => {
    const output = serializeConversation(messages, ".md");
    expect(output).toContain("## You\n\nExplain this");
    expect(output).toContain("## Forge");
    expect(output).not.toContain("private setup");
  });

  it("preserves the complete transcript in JSON", () => {
    expect(JSON.parse(serializeConversation(messages, ".json"))).toEqual(messages);
  });
});
