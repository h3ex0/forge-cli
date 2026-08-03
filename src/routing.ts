import type { ModelCandidate, ModelCapability } from "./runtime/types.js";

export interface RouteRequest {
  mode: "manual" | "auto";
  pinned?: string;
  offline?: boolean;
  required: ModelCapability[];
}

function supports(candidate: ModelCandidate, required: ModelCapability[]): boolean {
  return required.every((capability) => candidate.capabilities.includes(capability));
}

export function selectModel(candidates: ModelCandidate[], request: RouteRequest): ModelCandidate | undefined {
  const eligible = candidates.filter((candidate) => candidate.healthy && supports(candidate, request.required));
  if (request.pinned) return eligible.find((candidate) => candidate.ref === request.pinned);
  const constrained = request.offline ? eligible.filter((candidate) => candidate.local) : eligible;
  const selected = constrained.find((candidate) => candidate.local) ?? constrained[0];
  if (!selected) return undefined;
  return selected.local ? selected : { ...selected, requiresCloudApproval: true };
}
