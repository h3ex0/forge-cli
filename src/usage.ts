import type { ForgeConfig, Profile } from "./config.js";
import type { ProviderRateLimits } from "./providers/types.js";

export interface UsageView {
  promptTokens: number;
  completionTokens: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
  rateLimits?: ProviderRateLimits;
  subscriptionTokensUsed?: number;
}

/** Format a non-negative counter for a narrow terminal status line. */
export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString("en-US");
}

/** Estimate tokens from text length when the provider has not supplied a tokenizer. */
export function estimateMessageTokens(messages: Array<{ content: string }>): number {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(characters / 4);
}

/** Estimate session cost from provider pricing, returning undefined when pricing is unavailable. */
export function estimateCost(profile: Profile, usage: UsageView, pricing?: { inputPricePerMillion?: number; outputPricePerMillion?: number }): number | undefined {
  if (!pricing || (pricing.inputPricePerMillion == null && pricing.outputPricePerMillion == null)) return undefined;
  return (usage.promptTokens / 1_000_000) * (pricing.inputPricePerMillion ?? 0)
    + (usage.completionTokens / 1_000_000) * (pricing.outputPricePerMillion ?? 0);
}

/** Render token, context, cost, plan, and provider-rate data within a column budget. */
export function renderUsageStatus(config: ForgeConfig, usage: UsageView, columns = 160): string {
  const profile = config.profiles[config.activeProfile];
  if (!profile) return "No active profile";
  const total = usage.promptTokens + usage.completionTokens;
  const parts = [`tokens ${compactNumber(total)} (in ${compactNumber(usage.promptTokens)} / out ${compactNumber(usage.completionTokens)})`];
  if (usage.contextTokens != null) {
    const window = profile.contextWindowTokens;
    const ratio = window ? usage.contextTokens / window : undefined;
    const warn = ratio != null && ratio >= 0.9 ? "! " : "";
    parts.push(window ? `${warn}context ~${compactNumber(usage.contextTokens)}/${compactNumber(window)}` : `context ~${compactNumber(usage.contextTokens)}`);
  }
  if (usage.estimatedCostUsd != null) parts.push(`cost $${usage.estimatedCostUsd.toFixed(usage.estimatedCostUsd < 0.1 ? 4 : 2)}`);

  const subscription = profile.subscription;
  if (subscription?.name) parts.push(`plan ${subscription.name}`);
  const planTokens = usage.subscriptionTokensUsed ?? total;
  if (subscription?.tokenLimit) parts.push(`${planTokens >= subscription.tokenLimit ? "! " : ""}plan tokens ${compactNumber(planTokens)}/${compactNumber(subscription.tokenLimit)}`);
  if (subscription?.costLimitUsd != null && usage.estimatedCostUsd != null) {
    parts.push(`${usage.estimatedCostUsd >= subscription.costLimitUsd ? "! " : ""}budget $${usage.estimatedCostUsd.toFixed(2)}/$${subscription.costLimitUsd.toFixed(2)}`);
  }
  if (subscription?.resetAt) parts.push(`resets ${subscription.resetAt}`);
  if (usage.rateLimits?.tokenRemaining != null) {
    const limit = usage.rateLimits.tokenLimit != null ? `/${compactNumber(usage.rateLimits.tokenLimit)}` : "";
    parts.push(`rate tokens ${compactNumber(usage.rateLimits.tokenRemaining)}${limit} left`);
  }
  if (usage.rateLimits?.requestRemaining != null) {
    const limit = usage.rateLimits.requestLimit != null ? `/${compactNumber(usage.rateLimits.requestLimit)}` : "";
    parts.push(`requests ${compactNumber(usage.rateLimits.requestRemaining)}${limit} left`);
  }
  const line = parts.join(" | ");
  return line.length <= columns ? line : `${line.slice(0, Math.max(1, columns - 1))}…`;
}
