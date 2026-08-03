import { parseArgsStringToArgv } from "string-argv";

export interface ParsedSlashCommand {
  name: string;
  args: string[];
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const argv = parseArgsStringToArgv(trimmed.slice(1));
  const [name, ...args] = argv;
  return name ? { name: name.toLowerCase(), args } : null;
}
