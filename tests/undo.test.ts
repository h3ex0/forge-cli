import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyUndo, clearUndoJournals, popUndo, recordUndo, snapshotPath, undoStackSize } from "../src/undo.js";

const created: string[] = [];
afterEach(() => {
  clearUndoJournals();
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-undo-"));
  created.push(root);
  return root;
}

describe("undo journal", () => {
  it("snapshots an existing text file and restores it on undo", () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "original");
    const before = snapshotPath(root, "a.txt")!;
    expect(before).toEqual({ path: "a.txt", existed: true, content: "original" });

    fs.writeFileSync(path.join(root, "a.txt"), "changed");
    recordUndo(root, "write_file", [before]);
    expect(undoStackSize(root)).toBe(1);

    const entry = popUndo(root)!;
    const touched = applyUndo(root, entry);
    expect(touched).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe("original");
    expect(undoStackSize(root)).toBe(0);
  });

  it("deletes a file on undo when it did not exist before", () => {
    const root = tempWorkspace();
    const before = snapshotPath(root, "new.txt")!;
    expect(before).toEqual({ path: "new.txt", existed: false });

    fs.writeFileSync(path.join(root, "new.txt"), "created by the tool");
    recordUndo(root, "write_file", [before]);
    applyUndo(root, popUndo(root)!);

    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  it("refuses to snapshot directories or binary-looking content", () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, "dir"));
    expect(snapshotPath(root, "dir")).toBeNull();

    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    expect(snapshotPath(root, "bin.dat")).toBeNull();
  });

  it("caps the journal at 50 entries per workspace", () => {
    const root = tempWorkspace();
    for (let i = 0; i < 55; i += 1) recordUndo(root, "write_file", [{ path: `f${i}.txt`, existed: false }]);
    expect(undoStackSize(root)).toBe(50);
    expect(popUndo(root)?.snapshots[0].path).toBe("f54.txt");
  });
});
