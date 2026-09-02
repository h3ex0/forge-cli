import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";
const MAX_BODY = 24_000;
/**
 * Skills are markdown files with optional `name:`/`description:` frontmatter.
 * Two locations are searched: the workspace's own .forge/skills (checked into
 * the project, shared with whoever clones it) and the user's ~/.forge/skills
 * (personal, available in every workspace).
 */
function skillDirs(workspaceRoot) {
    return [
        { dir: path.join(path.resolve(workspaceRoot), ".forge", "skills"), scope: "workspace" },
        { dir: path.join(CONFIG_DIR, "skills"), scope: "user" },
    ];
}
function parseSkill(file, scope) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf-8");
    }
    catch {
        return undefined;
    }
    const fallbackName = path.basename(file).replace(/\.mdx?$/i, "");
    let description = "";
    let body = raw;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    let name = fallbackName;
    if (frontmatter) {
        body = raw.slice(frontmatter[0].length);
        for (const line of frontmatter[1].split(/\r?\n/)) {
            const match = /^(name|description):\s*(.*)$/.exec(line.trim());
            if (!match)
                continue;
            const value = match[2].trim().replace(/^["']|["']$/g, "");
            if (match[1] === "name" && value)
                name = value;
            if (match[1] === "description")
                description = value;
        }
    }
    if (!description) {
        // No frontmatter description: use the first non-heading line so the list
        // still says something useful about the skill.
        description = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
    }
    return {
        name,
        description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
        body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…[skill truncated]` : body.trim(),
        source: file,
        scope,
    };
}
/** Every available skill, workspace scope shadowing user scope by name. */
export function listSkills(workspaceRoot) {
    const found = new Map();
    for (const { dir, scope } of skillDirs(workspaceRoot)) {
        let entries;
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries.sort()) {
            if (!/\.mdx?$/i.test(entry))
                continue;
            const skill = parseSkill(path.join(dir, entry), scope);
            if (!skill)
                continue;
            // Workspace is scanned first; don't let a user skill shadow it.
            if (!found.has(skill.name.toLowerCase()))
                found.set(skill.name.toLowerCase(), skill);
        }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function findSkill(workspaceRoot, name) {
    const wanted = name.trim().toLowerCase();
    const skills = listSkills(workspaceRoot);
    return skills.find((skill) => skill.name.toLowerCase() === wanted)
        ?? skills.find((skill) => skill.name.toLowerCase().startsWith(wanted));
}
/** One-line-per-skill catalogue for the system prompt. */
export function skillsPromptSection(workspaceRoot) {
    const skills = listSkills(workspaceRoot);
    if (!skills.length)
        return "";
    const lines = skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`);
    return `\n\nSkills available in this workspace. Call skill_read with the skill's name to load its full instructions before doing that kind of work:\n${lines.join("\n")}`;
}
