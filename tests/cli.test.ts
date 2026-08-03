import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";

describe("top-level CLI", () => {
  it("exposes interactive, automation, model, runtime, and diagnostics commands", () => {
    const names = createProgram().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["chat", "tui", "run", "model", "runtime", "session", "doctor", "completion"]));
  });

  it("reports the v0.2 release", () => {
    expect(createProgram().version()).toBe("0.2.0");
  });
});
