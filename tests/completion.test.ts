import { describe, expect, it } from "vitest";
import { completeSlashCommand } from "../src/line-source.js";

describe("slash completion", () => {
  it("completes a unique command prefix", () => {
    expect(completeSlashCommand("/worksp")).toEqual({ value: "/workspace ", candidates: ["/workspace"] });
  });

  it("returns candidates for an ambiguous prefix", () => {
    expect(completeSlashCommand("/r").candidates).toEqual(expect.arrayContaining(["/review", "/route", "/runtime"]));
  });
});
