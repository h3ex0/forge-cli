import { describe, expect, it } from "vitest";
import { decidePermission } from "../src/security/policy.js";

describe("tool permission policy", () => {
  it("denies mutations in read-only mode", () => {
    expect(decidePermission("read-only", "write")).toBe("deny");
    expect(decidePermission("read-only", "process")).toBe("deny");
  });

  it("asks for mutations in balanced mode", () => {
    expect(decidePermission("balanced", "read")).toBe("allow");
    expect(decidePermission("balanced", "write")).toBe("ask");
    expect(decidePermission("balanced", "network")).toBe("ask");
  });

  it("still asks for high-risk actions in autonomous mode", () => {
    expect(decidePermission("autonomous", "write")).toBe("allow");
    expect(decidePermission("autonomous", "process")).toBe("ask");
    expect(decidePermission("autonomous", "external")).toBe("ask");
  });
});
