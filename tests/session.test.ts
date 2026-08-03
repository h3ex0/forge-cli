import { describe, expect, it } from "vitest";
import { validateSessionName } from "../src/session.js";

describe("session names", () => {
  it("accepts readable safe names", () => {
    expect(validateSessionName("qwen-refactor_01")).toBe("qwen-refactor_01");
  });

  it("rejects traversal and separators", () => {
    expect(() => validateSessionName("../secrets")).toThrow(/session name/i);
    expect(() => validateSessionName("nested/name")).toThrow(/session name/i);
  });
});
