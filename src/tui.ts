import React from "react";
import { render } from "ink";
import type { ForgeConfig } from "./config.js";
import { ForgeTui } from "./tui/app.js";

/** Start Forge in an alternate-screen Ink workspace and wait until it exits. */
export async function startTui(config: ForgeConfig): Promise<void> {
  const instance = render(React.createElement(ForgeTui, { config }), {
    exitOnCtrlC: false,
    alternateScreen: true,
    incrementalRendering: true,
  });
  await instance.waitUntilExit();
}
