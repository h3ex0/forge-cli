import stringWidth from "string-width";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function toGraphemes(text) {
    return Array.from(graphemeSegmenter.segment(text), (entry) => entry.segment);
}
/**
 * Wrap plain terminal text into selectable rows without pane borders or
 * adjacent columns.
 *
 * Wraps by visual terminal width (via string-width), not `.length`/`.slice()`
 * on the raw string: those count UTF-16 code units, which silently
 * undercounts wide characters (CJK, fullwidth forms, many emoji render as 2
 * terminal columns per 1-2 code units). Pasted, human-written prompts are
 * far more likely than an LLM's own output to contain them, so a
 * length-based wrap could put roughly twice as many "columns" of such text
 * on a line as actually fit — the line overflows its box on real terminals
 * while looking correct by string length. Segmenting into grapheme clusters
 * also keeps multi-code-point emoji and combining characters intact instead
 * of risking a slice through the middle of one.
 */
export function wrapReaderText(value, width) {
    const limit = Math.max(10, Math.floor(width));
    const output = [];
    for (const sourceLine of value.replace(/\r\n/g, "\n").split("\n")) {
        if (!sourceLine) {
            output.push("");
            continue;
        }
        const clusters = toGraphemes(sourceLine);
        let line = [];
        let lineWidth = 0;
        let lastBreakIndex = -1; // index into `line` of the most recent whitespace cluster
        for (const cluster of clusters) {
            const clusterWidth = stringWidth(cluster);
            if (lineWidth + clusterWidth > limit && line.length > 0) {
                if (lastBreakIndex >= Math.floor(line.length * 0.45)) {
                    output.push(line.slice(0, lastBreakIndex).join("").trimEnd());
                    line = line.slice(lastBreakIndex + 1);
                }
                else {
                    output.push(line.join(""));
                    line = [];
                }
                lineWidth = line.reduce((sum, item) => sum + stringWidth(item), 0);
                lastBreakIndex = -1;
            }
            if (cluster === " " || cluster === "\t")
                lastBreakIndex = line.length;
            line.push(cluster);
            lineWidth += clusterWidth;
        }
        output.push(line.join(""));
    }
    return output;
}
/** Pretty-print an HTTP JSON error body while preserving ordinary status text. */
export function formatReaderStatus(value) {
    const jsonStart = value.indexOf("{");
    if (jsonStart < 0)
        return value;
    try {
        const parsed = JSON.parse(value.slice(jsonStart));
        return `${value.slice(0, jsonStart).trimEnd()}\n${JSON.stringify(parsed, null, 2)}`;
    }
    catch {
        return value;
    }
}
