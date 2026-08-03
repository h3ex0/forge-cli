import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearProfileUsage, loadUsageLedger, recordUsage } from "../src/usage-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("usage ledger", () => {
  it("accumulates and resets per-profile token usage", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forge-usage-"));
    directories.push(directory);
    const file = path.join(directory, "usage.json");
    recordUsage("local", 10, 5, file);
    recordUsage("local", 20, 7, file);
    expect(loadUsageLedger(file).profiles.local).toMatchObject({ promptTokens: 30, completionTokens: 12 });
    clearProfileUsage("local", file);
    expect(loadUsageLedger(file).profiles.local).toBeUndefined();
  });

  it("recovers from an invalid ledger", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forge-usage-"));
    directories.push(directory);
    const file = path.join(directory, "usage.json");
    fs.writeFileSync(file, "not-json");
    expect(loadUsageLedger(file)).toEqual({ schemaVersion: 1, profiles: {} });
  });
});
