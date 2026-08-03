import { describe, expect, it } from "vitest";
import { sanitizeTerminalText, summarizeToolArguments } from "../src/tui/sanitize.js";

describe("TUI terminal sanitization", () => {
  it("removes ANSI styling and operating-system command sequences", () => {
    expect(sanitizeTerminalText("safe\u001b[31mred\u001b[0m\u001b]0;owned\u0007text")).toBe("saferedtext");
  });

  it("preserves readable whitespace", () => {
    expect(sanitizeTerminalText("one\ntwo\tthree")).toBe("one\ntwo\tthree");
  });

  it("redacts credential-like fields and summarizes file contents", () => {
    const summary = summarizeToolArguments({ apiKey: "secret", content: "hello", path: "a.txt" });
    expect(summary).toContain('"apiKey": "<redacted>"');
    expect(summary).toContain('"content": "<5 characters>"');
    expect(summary).not.toContain("secret");
  });
});
