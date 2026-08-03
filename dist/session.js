import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";
export function validateSessionName(name) {
    const trimmed = name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(trimmed) || trimmed.includes("..")) {
        throw new Error("Invalid session name. Use 1-80 letters, numbers, dots, underscores, or hyphens without '..'.");
    }
    return trimmed;
}
export function listSessions() {
    if (!fs.existsSync(SESSIONS_DIR))
        return [];
    return fs
        .readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
}
export function saveSession(name, messages) {
    if (!fs.existsSync(SESSIONS_DIR))
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = path.join(SESSIONS_DIR, `${validateSessionName(name)}.json`);
    fs.writeFileSync(file, JSON.stringify(messages, null, 2), "utf-8");
}
export function loadSession(name) {
    const file = path.join(SESSIONS_DIR, `${validateSessionName(name)}.json`);
    return JSON.parse(fs.readFileSync(file, "utf-8"));
}
export function defaultSessionName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
