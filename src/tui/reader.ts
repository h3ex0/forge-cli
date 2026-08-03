/** Wrap plain terminal text into selectable rows without pane borders or adjacent columns. */
export function wrapReaderText(value: string, width: number): string[] {
  const limit = Math.max(10, Math.floor(width));
  const output: string[] = [];
  for (const sourceLine of value.replace(/\r\n/g, "\n").split("\n")) {
    let line = sourceLine;
    if (!line) { output.push(""); continue; }
    while (line.length > limit) {
      const candidate = line.slice(0, limit + 1);
      const whitespace = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
      const splitAt = whitespace >= Math.floor(limit * 0.45) ? whitespace : limit;
      output.push(line.slice(0, splitAt).trimEnd());
      line = line.slice(splitAt + (whitespace === splitAt ? 1 : 0)).trimStart();
    }
    output.push(line);
  }
  return output;
}

/** Pretty-print an HTTP JSON error body while preserving ordinary status text. */
export function formatReaderStatus(value: string): string {
  const jsonStart = value.indexOf("{");
  if (jsonStart < 0) return value;
  try {
    const parsed = JSON.parse(value.slice(jsonStart));
    return `${value.slice(0, jsonStart).trimEnd()}\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return value;
  }
}
