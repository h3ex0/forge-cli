import React from "react";
import { render } from "ink";
import { ForgeTui } from "./tui/app.js";
let activeInstance = null;
/**
 * Best-effort terminal restore for a crash. If something throws while the
 * TUI is running (alternate screen + raw mode), letting the process exit
 * without unmounting Ink leaves the terminal showing whatever the alternate
 * screen last had on it, cursor hidden, and raw mode still engaged —
 * indistinguishable from "everything is corrupted" even once the process is
 * dead. reportCliError calls this before exiting so a crash always leaves a
 * normal, usable terminal behind.
 */
export function unmountActiveTui() {
    try {
        activeInstance?.unmount();
    }
    catch { /* already exiting; best effort only */ }
    activeInstance = null;
}
/** Start Forge in an alternate-screen Ink workspace and wait until it exits. */
export async function startTui(config) {
    const instance = render(React.createElement(ForgeTui, { config }), {
        exitOnCtrlC: false,
        alternateScreen: true,
    });
    activeInstance = instance;
    try {
        await instance.waitUntilExit();
    }
    finally {
        if (activeInstance === instance)
            activeInstance = null;
    }
}
