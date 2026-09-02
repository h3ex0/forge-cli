import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteProfileSecret } from "../src/security/secrets.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  process.env.FORGE_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  // These tests write real API-key entries into the OS keychain (there is no
  // FORGE_HOME-scoped keyring service to redirect them to) — remove whatever
  // profile names this test created so they don't linger in Credential Manager.
  if (fs.existsSync(path.join(home, "config.json"))) {
    for (const name of Object.keys(readConfig().profiles as Record<string, unknown>)) deleteProfileSecret(name);
  }
  delete process.env.FORGE_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const { createProgram } = await import("../src/cli.js");
  await createProgram().parseAsync(["node", "forge", ...args]);
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf-8"));
}

// These tests hit the real OS keychain. On Windows the first Credential
// Manager access in a run can take several seconds, which intermittently
// blew the 5s default and made this file flaky.
describe("forge provider / key CLI commands", { timeout: 30_000 }, () => {
  it("adds a provider with an explicit key, activates it, and lists it", async () => {
    await run("provider", "add", "testprov", "https://api.example.test/v1", "test-model", "--key", "secret-key");
    const config = readConfig();
    expect(config.activeProfile).toBe("testprov");
    expect(config.profiles).toHaveProperty("testprov");
    expect((config.profiles as Record<string, { model: string; format: string }>).testprov).toMatchObject({ model: "test-model", format: "openai" });
  });

  it("rejects a base URL without a scheme", async () => {
    await expect(run("provider", "add", "bad", "not-a-url", "model", "--key", "x")).rejects.toThrow();
  });

  it("rejects an unknown format", async () => {
    await expect(run("provider", "add", "bad", "https://api.example.test", "model", "--key", "x", "--format", "carrierpigeon")).rejects.toThrow();
  });

  it("refuses to add a provider name that already exists", async () => {
    await run("provider", "add", "dupe", "https://api.example.test/v1", "model", "--key", "x");
    await expect(run("provider", "add", "dupe", "https://api.example.test/v1", "model", "--key", "y")).rejects.toThrow(/already exists/);
  });

  it("switches the active provider with `provider use`", async () => {
    await run("provider", "add", "first", "https://api.example.test/v1", "model", "--key", "x");
    await run("provider", "add", "second", "https://api.example.test/v1", "model", "--key", "y");
    await run("provider", "use", "first");
    expect(readConfig().activeProfile).toBe("first");
  });

  it("refuses to remove the active provider but allows removing an inactive one", async () => {
    await run("provider", "add", "keep", "https://api.example.test/v1", "model", "--key", "x");
    await run("provider", "add", "drop", "https://api.example.test/v1", "model", "--key", "y");
    await run("provider", "use", "keep");
    await expect(run("provider", "remove", "keep")).rejects.toThrow(/active profile/);
    await run("provider", "remove", "drop");
    expect(readConfig().profiles).not.toHaveProperty("drop");
  });

  it("updates a provider's key with `key set`", async () => {
    await run("provider", "add", "rotating", "https://api.example.test/v1", "model", "--key", "old-key");
    await expect(run("key", "set", "missing-profile", "--key", "z")).rejects.toThrow(/Unknown profile/);
    await run("key", "set", "rotating", "--key", "new-key");
    expect(readConfig().profiles).toHaveProperty("rotating");
  });
});
