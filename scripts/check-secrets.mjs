#!/usr/bin/env node
// Fails the build if a real-looking API key or credential shows up in a tracked file.
// Run automatically by `npm run verify` — the last gate before a build or publish.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const PATTERNS = [
  [/sk-or-v1-[A-Za-z0-9]{20,}/g, "OpenRouter key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "Anthropic key"],
  [/sk-[A-Za-z0-9]{20,}/g, "OpenAI-style key"],
  [/AIza[0-9A-Za-z_-]{35}/g, "Google API key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "GitHub token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key block"],
];

// Forge's own config/session files are gitignored, never in `files[]`, and hold
// real user keys only on disk — allowlist their filenames in case one is ever
// accidentally staged, so this scan's job stays "catch it before it's committed".
const ALLOW_PATH = /(^|\/)(node_modules|dist|\.git)\//;

function trackedFiles() {
  const output = execFileSync("git", ["ls-files"], { encoding: "utf-8" });
  return output.split("\n").filter(Boolean).filter((path) => !ALLOW_PATH.test(path));
}

let found = 0;
for (const path of trackedFiles()) {
  let content;
  try {
    content = fs.readFileSync(path, "utf-8");
  } catch {
    continue; // binary or unreadable — not a plausible secret carrier
  }
  for (const [pattern, label] of PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      found += matches.length;
      console.error(`Possible ${label} in ${path}: ${matches[0].slice(0, 12)}…`);
    }
  }
}

if (found > 0) {
  console.error(`\n${found} possible secret(s) found in tracked files. Remove them and rotate any real key before committing.`);
  process.exit(1);
}
console.log("No committed secrets detected.");
