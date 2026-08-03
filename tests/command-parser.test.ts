import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../src/commands/parser.js";
import { slashCommandNames } from "../src/commands/registry.js";

describe("slash command parser", () => {
  it("supports nested commands and quoted arguments", () => {
    expect(parseSlashCommand('/model pull "qwen3 coder:8b"')).toEqual({
      name: "model",
      args: ["pull", "qwen3 coder:8b"],
    });
  });

  it("rejects ordinary chat input", () => {
    expect(parseSlashCommand("explain this project")).toBeNull();
  });

  it("exposes the expanded command families for help and completion", () => {
    expect(slashCommandNames()).toEqual(expect.arrayContaining([
      "model", "runtime", "workspace", "read", "search", "check", "run",
      "explain", "security", "resume", "export", "usage", "doctor", "ui",
    ]));
  });
});
