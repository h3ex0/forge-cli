import { Entry } from "@napi-rs/keyring";
const SERVICE = "forge-cli";
function envName(profileName) {
    return `FORGE_API_KEY_${profileName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}
export function storeProfileSecret(profileName, secret) {
    if (!secret)
        return true;
    try {
        new Entry(SERVICE, profileName).setPassword(secret);
        return true;
    }
    catch {
        return false;
    }
}
export function loadProfileSecret(profileName) {
    const fromEnvironment = process.env[envName(profileName)];
    if (fromEnvironment)
        return fromEnvironment;
    try {
        return new Entry(SERVICE, profileName).getPassword() ?? "";
    }
    catch {
        return "";
    }
}
