import type { ForgeConfig, RuntimeKind } from "../config.js";
import { createLocalProfile, createRuntimeAdapter, parseModelRef, runtimeKinds } from "./registry.js";
import type { LocalModel, ModelCapabilities, PullProgress, RuntimeHealth } from "./types.js";

export interface RuntimeSummary {
  kind: RuntimeKind;
  health: RuntimeHealth;
  models: LocalModel[];
}

export function activateLocalModel(config: ForgeConfig, reference: string): string {
  const { runtime, model } = parseModelRef(reference);
  const profileName = `local-${runtime}`;
  config.profiles[profileName] = createLocalProfile(runtime, model, config.runtimes[runtime].baseURL);
  config.activeProfile = profileName;
  return profileName;
}

export async function inspectLocalModel(config: ForgeConfig, reference: string): Promise<ModelCapabilities> {
  const { runtime, model } = parseModelRef(reference);
  return createRuntimeAdapter(runtime, config).inspectModel(model);
}

export async function listRuntimeSummaries(config: ForgeConfig): Promise<RuntimeSummary[]> {
  return Promise.all(runtimeKinds().map(async (kind) => {
    const adapter = createRuntimeAdapter(kind, config);
    const health = await adapter.health();
    let models: LocalModel[] = [];
    if (health.healthy) {
      try { models = await adapter.listModels(); } catch { /* health remains useful */ }
    }
    return { kind, health, models };
  }));
}

export async function* pullLocalModel(config: ForgeConfig, reference: string, signal?: AbortSignal): AsyncIterable<PullProgress> {
  const { runtime, model } = parseModelRef(reference);
  const adapter = createRuntimeAdapter(runtime, config);
  if (!adapter.pullModel) throw new Error(`${runtime} does not expose managed downloads through Forge yet.`);
  yield* adapter.pullModel(model, signal);
}
