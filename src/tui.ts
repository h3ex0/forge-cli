import React from "react";
import { render, type Instance } from "ink";
import type { ForgeConfig } from "./config.js";
import { ForgeTui } from "./tui/app.js";

let activeInstance: Instance | null = null;

/**
 * Best-effort terminal restore for a crash. If something throws while the
 * TUI is running (alternate screen + raw mode), letting the process exit
 * without unmounting Ink leaves the terminal showing whatever the alternate
 * screen last had on it, cursor hidden, and raw mode still engaged —
 * indistinguishable from "everything is corrupted" even once the process is
 * dead. reportCliError calls this before exiting so a crash always leaves a
 * normal, usable terminal behind.
 */
export function unmountActiveTui(): void {
  try { activeInstance?.unmount(); } catch { /* already exiting; best effort only */ }
  activeInstance = null;
}

/** Start Forge in an alternate-screen Ink workspace and wait until it exits. */
export async function startTui(config: ForgeConfig): Promise<void> {
  const instance = render(React.createElement(ForgeTui, { config }), {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  activeInstance = instance;
  try {
    await instance.waitUntilExit();
  } finally {
    if (activeInstance === instance) activeInstance = null;
  }
}
