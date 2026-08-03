import { describe, expect, it } from "vitest";
import { createProgram, shouldLaunchTui } from "../src/cli.js";
import { migrateConfig } from "../src/config.js";

describe("top-level CLI", () => {
  it("exposes interactive, automation, model, runtime, and diagnostics commands", () => {
    const names = createProgram().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["chat", "tui", "run", "model", "runtime", "session", "limit", "doctor", "completion"]));
  });

  it("reports the v0.3 release", () => {
    expect(createProgram().version()).toBe("0.4.0");
  });

  it("uses TUI only for capable interactive terminals", () => {
    const config = migrateConfig(undefined);
    expect(shouldLaunchTui(config, { inputIsTTY: true, outputIsTTY: true, columns: 120, rows: 30 })).toBe(true);
    expect(shouldLaunchTui(config, { inputIsTTY: false, outputIsTTY: true, columns: 120, rows: 30 })).toBe(false);
    expect(shouldLaunchTui(config, { inputIsTTY: true, outputIsTTY: true, columns: 60, rows: 30 })).toBe(false);
    config.ui.mode = "inline";
    expect(shouldLaunchTui(config, { inputIsTTY: true, outputIsTTY: true, columns: 120, rows: 30 })).toBe(false);
  });
});
