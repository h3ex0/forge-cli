export function decidePermission(mode, risk) {
    if (mode === "read-only")
        return risk === "read" ? "allow" : "deny";
    if (mode === "balanced")
        return risk === "read" ? "allow" : "ask";
    return risk === "read" || risk === "write" ? "allow" : "ask";
}
