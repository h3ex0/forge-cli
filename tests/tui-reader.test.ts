import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { formatReaderStatus, wrapReaderText } from "../src/tui/reader.js";

describe("pane reader", () => {
  it("wraps by visual width, not UTF-16 length, for double-width CJK text", () => {
    // Every character here is a single UTF-16 code unit but renders as 2
    // terminal columns; a length-based wrap would let a "40-char" line
    // render at 80 columns, overflowing its box on a real terminal.
    const text = "请创建一个现代化的高转化率落地页面用于专业编程和软件开发服务的营销推广活动方案设计";
    const lines = wrapReaderText(text, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
    expect(lines.join("")).toBe(text);
  });

  it("keeps multi-code-point emoji intact instead of slicing through them", () => {
    const text = "eye-catching 🚀🔥 for a software company";
    const lines = wrapReaderText(text, 20);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    // Rejoining with the space the wrap consumed at each break should
    // reproduce the original text with no mangled surrogate pairs.
    expect(lines.join(" ")).toBe(text);
  });

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
