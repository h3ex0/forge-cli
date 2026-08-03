import fs from "node:fs";
import path from "node:path";

export interface ResolvePathOptions {
  allowMissing?: boolean;
}

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(normalized(root), normalized(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside workspace: ${candidate}`);
  }
}

export function resolveWorkspacePath(root: string, input: string, options: ResolvePathOptions = {}): string {
  const rootReal = fs.realpathSync(path.resolve(root));
  const requested = path.resolve(rootReal, input);
  assertInside(rootReal, requested);

  if (fs.existsSync(requested)) {
    const real = fs.realpathSync(requested);
    assertInside(rootReal, real);
    return real;
  }
  if (!options.allowMissing) throw new Error(`Path does not exist: ${requested}`);

  let ancestor = path.dirname(requested);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Could not resolve path: ${requested}`);
    ancestor = parent;
  }
  const ancestorReal = fs.realpathSync(ancestor);
  assertInside(rootReal, ancestorReal);
  const result = path.join(ancestorReal, path.relative(ancestor, requested));
  assertInside(rootReal, result);
  return result;
}
