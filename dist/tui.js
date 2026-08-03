import React from "react";
import { render } from "ink";
import { ForgeTui } from "./tui/app.js";
/** Start Forge in an alternate-screen Ink workspace and wait until it exits. */
export async function startTui(config) {
    const instance = render(React.createElement(ForgeTui, { config }), {
        exitOnCtrlC: false,
        alternateScreen: true,
        incrementalRendering: true,
    });
    await instance.waitUntilExit();
}
