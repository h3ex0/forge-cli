import { describe, expect, it } from "vitest";
import { migrateConfig } from "../src/config.js";
import { compactNumber, estimateMessageTokens, renderUsageStatus } from "../src/usage.js";

describe("usage status", () => {
  it("renders consumed tokens and configured subscription limits", () => {
    const config = migrateConfig({
      activeProfile: "test",
      profiles: { test: { baseURL: "https://example.test/v1", apiKey: "", format: "openai", model: "qwen" } },
    });
    config.profiles.test.subscription = { name: "Pro", tokenLimit: 1_000_000, costLimitUsd: 20 };
    const line = renderUsageStatus(config, { promptTokens: 1200, completionTokens: 300, contextTokens: 800, estimatedCostUsd: 1.25, subscriptionTokensUsed: 900_000 });
    expect(line).toContain("tokens 1.5k");
    expect(line).toContain("plan Pro");
    expect(line).toContain("plan tokens 900k/1.0m");
    expect(line).toContain("budget $1.25/$20.00");
  });

  it("renders provider-reported remaining limits", () => {
    const config = migrateConfig({ activeProfile: "test", profiles: { test: { baseURL: "https://example.test", apiKey: "", format: "openai", model: "qwen" } } });
    const line = renderUsageStatus(config, { promptTokens: 10, completionTokens: 5, rateLimits: { tokenLimit: 10_000, tokenRemaining: 8_000 } });
    expect(line).toContain("rate tokens 8.0k/10k left");
  });

  it("estimates context and formats compact values", () => {
    expect(estimateMessageTokens([{ content: "12345678" }])).toBe(2);
    expect(compactNumber(12_000)).toBe("12k");
  });
});
