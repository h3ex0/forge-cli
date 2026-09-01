import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./security/workspace.js";
const MAX_ENTRIES = 50;
const journals = new Map();
/** Record a completed mutation's pre-change state. No-op for an empty snapshot list. */
export function recordUndo(workspaceRoot, tool, snapshots) {
    if (!snapshots.length)
        return;
    const stack = journals.get(workspaceRoot) ?? [];
    stack.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tool, timestamp: Date.now(), snapshots });
    if (stack.length > MAX_ENTRIES)
        stack.shift();
    journals.set(workspaceRoot, stack);
}
/** Remove and return the most recent undo entry, if any. */
export function popUndo(workspaceRoot) {
    return journals.get(workspaceRoot)?.pop();
}
export function undoStackSize(workspaceRoot) {
    return journals.get(workspaceRoot)?.length ?? 0;
}
/**
 * Read a path's current state for later restoration. Returns null when the
 * path can't be safely captured (a directory, or content that doesn't look
 * like text) — callers should skip recording undo for the whole call rather
 * than risk corrupting a binary file on restore.
 */
export function snapshotPath(workspaceRoot, relativePath) {
    try {
        const file = resolveWorkspacePath(workspaceRoot, relativePath, { allowMissing: true });
        if (!fs.existsSync(file))
            return { path: relativePath, existed: false };
        if (!fs.statSync(file).isFile())
            return null;
        const buffer = fs.readFileSync(file);
        if (buffer.subarray(0, 8000).includes(0))
            return null; // looks binary
        return { path: relativePath, existed: true, content: buffer.toString("utf-8") };
    }
    catch {
        return null;
    }
}
/** Restore every snapshot in an undo entry. Returns the workspace-relative paths touched. */
export function applyUndo(workspaceRoot, entry) {
    const touched = [];
    for (const snapshot of entry.snapshots) {
        const file = resolveWorkspacePath(workspaceRoot, snapshot.path, { allowMissing: true });
        if (snapshot.existed) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, snapshot.content ?? "", "utf-8");
        }
        else if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
        touched.push(snapshot.path);
    }
    return touched;
}
/** Test-only: clear all recorded journals. */
export function clearUndoJournals() {
    journals.clear();
}
