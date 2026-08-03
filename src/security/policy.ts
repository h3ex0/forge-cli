import type { PermissionMode } from "../config.js";

export type ToolRisk = "read" | "write" | "process" | "network" | "credential" | "external";
export type PermissionDecision = "allow" | "ask" | "deny";

export function decidePermission(mode: PermissionMode, risk: ToolRisk): PermissionDecision {
  if (mode === "read-only") return risk === "read" ? "allow" : "deny";
  if (mode === "balanced") return risk === "read" ? "allow" : "ask";
  return risk === "read" || risk === "write" ? "allow" : "ask";
}
