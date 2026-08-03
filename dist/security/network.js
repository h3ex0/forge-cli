import dns from "node:dns/promises";
import net from "node:net";
function isPrivateIPv4(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
        return false;
    const [a, b] = parts;
    return (a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224);
}
function isPrivateAddress(ip) {
    if (net.isIPv4(ip))
        return isPrivateIPv4(ip);
    if (!net.isIPv6(ip))
        return true;
    const normalized = ip.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}
export async function validatePublicUrl(input) {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(`Unsupported URL protocol: ${url.protocol}`);
    if (url.username || url.password)
        throw new Error("Credentials in URLs are not allowed.");
    if (url.hostname.toLowerCase() === "localhost")
        throw new Error("Loopback and private network URLs are blocked.");
    const literal = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
    if (!literal.length || literal.some((entry) => isPrivateAddress(entry.address))) {
        throw new Error("Loopback and private network URLs are blocked.");
    }
    return url;
}
