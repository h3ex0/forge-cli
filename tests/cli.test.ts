import { describe, expect, it, vi } from "vitest";
import { createProgram, registerTuiModule, reportCliError, shouldLaunchTui } from "../src/cli.js";

describe("top-level CLI", () => {
  it("restores the terminal before exiting on a crash while the TUI is active", () => {
    const unmountActiveTui = vi.fn();
    registerTuiModule({ unmountActiveTui, startTui: vi.fn() } as never);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      reportCliError(new Error("boom"));
      expect(unmountActiveTui).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      errorLog.mockRestore();
      registerTuiModule(undefined as never);
    }
  });

  it("exposes interactive, automation, model, runtime, and diagnostics commands", () => {
    const names = createProgram().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["chat", "tui", "run", "model", "provider", "key", "runtime", "session", "limit", "doctor", "completion"]));
  });

  it("reports the v0.3 release", () => {
    expect(createProgram().version()).toBe("0.5.2");
  });

  it("requires a capable interactive terminal", () => {
    expect(shouldLaunchTui({ inputIsTTY: true, outputIsTTY: true, columns: 120, rows: 30 })).toBe(true);
    expect(shouldLaunchTui({ inputIsTTY: false, outputIsTTY: true, columns: 120, rows: 30 })).toBe(false);
    expect(shouldLaunchTui({ inputIsTTY: true, outputIsTTY: true, columns: 60, rows: 30 })).toBe(false);
  });
});
