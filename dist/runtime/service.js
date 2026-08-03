import { createLocalProfile, createRuntimeAdapter, parseModelRef, runtimeKinds } from "./registry.js";
export function activateLocalModel(config, reference) {
    const { runtime, model } = parseModelRef(reference);
    const profileName = `local-${runtime}`;
    config.profiles[profileName] = createLocalProfile(runtime, model, config.runtimes[runtime].baseURL);
    config.activeProfile = profileName;
    return profileName;
}
export async function inspectLocalModel(config, reference) {
    const { runtime, model } = parseModelRef(reference);
    return createRuntimeAdapter(runtime, config).inspectModel(model);
}
export async function listRuntimeSummaries(config) {
    return Promise.all(runtimeKinds().map(async (kind) => {
        const adapter = createRuntimeAdapter(kind, config);
        const health = await adapter.health();
        let models = [];
        if (health.healthy) {
            try {
                models = await adapter.listModels();
            }
            catch { /* health remains useful */ }
        }
        return { kind, health, models };
    }));
}
export async function* pullLocalModel(config, reference, signal) {
    const { runtime, model } = parseModelRef(reference);
    const adapter = createRuntimeAdapter(runtime, config);
    if (!adapter.pullModel)
        throw new Error(`${runtime} does not expose managed downloads through Forge yet.`);
    yield* adapter.pullModel(model, signal);
}
