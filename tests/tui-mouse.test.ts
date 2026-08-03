import { describe, expect, it } from "vitest";
import { containsPoint, parseMouseInput } from "../src/tui/mouse.js";

describe("TUI mouse protocol", () => {
  it("parses SGR clicks using zero-based coordinates", () => {
    expect(parseMouseInput("[<0;12;7M")).toMatchObject({ button: "left", action: "press", x: 11, y: 6 });
    expect(parseMouseInput("\x1b[<0;12;7m")).toMatchObject({ button: "left", action: "release" });
  });

  it("parses wheel direction and modifier bits", () => {
    expect(parseMouseInput("[<84;3;4M")).toMatchObject({ button: "wheel-up", action: "wheel", ctrl: true, shift: true });
    expect(parseMouseInput("[<65;3;4M")).toMatchObject({ button: "wheel-down", action: "wheel" });
  });

  it("hit-tests terminal cells with exclusive lower bounds", () => {
    const rectangle = { x: 2, y: 3, width: 5, height: 2 };
    expect(containsPoint(rectangle, 2, 3)).toBe(true);
    expect(containsPoint(rectangle, 6, 4)).toBe(true);
    expect(containsPoint(rectangle, 7, 4)).toBe(false);
  });
});
