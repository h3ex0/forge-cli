import { describe, expect, it } from "vitest";
import { formatReaderStatus, wrapReaderText } from "../src/tui/reader.js";

describe("pane reader", () => {
  it("wraps long errors into independent selectable rows", () => {
    const lines = wrapReaderText("Error: CUDA device kernel image is invalid", 18);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toContain("CUDA device kernel");
    expect(lines.every((line) => line.length <= 18)).toBe(true);
  });

  it("preserves explicit line breaks and blank rows", () => {
    expect(wrapReaderText("SESSION\n\nError detail", 80)).toEqual(["SESSION", "", "Error detail"]);
  });

  it("pretty-prints provider JSON errors for copying", () => {
    const output = formatReaderStatus('Error: HTTP 500: {"error":{"message":"CUDA error","code":null}}');
    expect(output).toContain("Error: HTTP 500:\n{");
    expect(output).toContain('\n    "message": "CUDA error"');
  });
});
