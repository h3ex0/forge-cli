import { parseArgsStringToArgv } from "string-argv";
export function parseSlashCommand(input) {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/"))
        return null;
    const argv = parseArgsStringToArgv(trimmed.slice(1));
    const [name, ...args] = argv;
    return name ? { name: name.toLowerCase(), args } : null;
}
