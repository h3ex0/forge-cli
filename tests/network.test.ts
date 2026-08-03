import { describe, expect, it } from "vitest";
import { validatePublicUrl } from "../src/security/network.js";

describe("network target validation", () => {
  it("rejects loopback and cloud metadata targets", async () => {
    await expect(validatePublicUrl("http://127.0.0.1/private")).rejects.toThrow(/private|loopback/i);
    await expect(validatePublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private|loopback/i);
  });

  it("rejects unsupported protocols", async () => {
    await expect(validatePublicUrl("file:///etc/passwd")).rejects.toThrow(/protocol/i);
  });
});
