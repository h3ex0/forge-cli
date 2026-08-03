const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
/** Remove terminal control sequences while preserving readable newlines and tabs. */
export function sanitizeTerminalText(value) {
    return value
        .replace(OSC_PATTERN, "")
        .replace(ANSI_PATTERN, "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "");
}
/** Redact credentials and full file bodies from tool arguments shown to a user. */
export function sanitizeToolArguments(args) {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => {
        if (/key|token|secret|password|authorization/i.test(key))
            return [key, "<redacted>"];
        if (["content", "old_string", "new_string"].includes(key) && typeof value === "string")
            return [key, `<${value.length} characters>`];
        return [key, typeof value === "string" ? sanitizeTerminalText(value) : value];
    }));
}
/** Produce a bounded approval summary without echoing likely credentials or full file contents. */
export function summarizeToolArguments(args) {
    const summarized = sanitizeToolArguments(args);
    return sanitizeTerminalText(JSON.stringify(summarized, null, 2)).slice(0, 4_000);
}
