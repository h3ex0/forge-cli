import fs from "node:fs";
import path from "node:path";

export interface ProjectInstruction {
  file: string;
  content: string;
}

export interface ProjectInfo {
  languages: string[];
  packageManager?: string;
  scripts: string[];
  git: boolean;
}

export function loadProjectInstructions(root: string): ProjectInstruction[] {
  const result: ProjectInstruction[] = [];
  for (const file of ["FORGE.md", "AGENTS.md"]) {
    const target = path.join(root, file);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      result.push({ file, content: fs.readFileSync(target, "utf-8").slice(0, 32_000) });
    }
  }
  return result;
}

export function detectProject(root: string): ProjectInfo {
  const languages: string[] = [];
  const has = (file: string): boolean => fs.existsSync(path.join(root, file));
  if (has("tsconfig.json")) languages.push("TypeScript");
  else if (has("package.json")) languages.push("JavaScript");
  if (has("pyproject.toml") || has("requirements.txt")) languages.push("Python");
  if (has("Cargo.toml")) languages.push("Rust");
  if (has("go.mod")) languages.push("Go");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) languages.push("Java/Kotlin");

  let packageManager: string | undefined;
  if (has("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (has("yarn.lock")) packageManager = "yarn";
  else if (has("package-lock.json") || has("package.json")) packageManager = "npm";

  let scripts: string[] = [];
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
      scripts = Object.keys(pkg.scripts ?? {}).sort();
    } catch { /* surfaced by doctor/build commands */ }
  }
  return { languages, packageManager, scripts, git: has(".git") };
}
