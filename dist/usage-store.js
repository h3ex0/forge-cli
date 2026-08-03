import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
const entrySchema = z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), updatedAt: z.string() });
const ledgerSchema = z.object({ schemaVersion: z.literal(1), profiles: z.record(z.string(), entrySchema) });
export const USAGE_PATH = path.join(os.homedir(), ".forge", "usage.json");
function saveUsageLedger(ledger, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporary, file);
    try {
        fs.chmodSync(file, 0o600);
    }
    catch { /* best effort on Windows */ }
}
/** Load the local per-profile token ledger, recovering safely from missing or invalid data. */
export function loadUsageLedger(file = USAGE_PATH) {
    try {
        return ledgerSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
    }
    catch {
        return { schemaVersion: 1, profiles: {} };
    }
}
/** Atomically add provider-reported token usage to one profile's local ledger. */
export function recordUsage(profile, promptTokens, completionTokens, file = USAGE_PATH) {
    const ledger = loadUsageLedger(file);
    const current = ledger.profiles[profile] ?? { promptTokens: 0, completionTokens: 0, updatedAt: new Date(0).toISOString() };
    ledger.profiles[profile] = {
        promptTokens: current.promptTokens + Math.max(0, Math.trunc(promptTokens)),
        completionTokens: current.completionTokens + Math.max(0, Math.trunc(completionTokens)),
        updatedAt: new Date().toISOString(),
    };
    saveUsageLedger(ledger, file);
    return ledger;
}
/** Clear locally recorded usage for a profile without changing provider billing data. */
export function clearProfileUsage(profile, file = USAGE_PATH) {
    const ledger = loadUsageLedger(file);
    delete ledger.profiles[profile];
    saveUsageLedger(ledger, file);
}
