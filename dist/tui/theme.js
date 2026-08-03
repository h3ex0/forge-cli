const THEMES = {
    flame: { accent: "magenta", text: "white", muted: "gray", success: "green", warning: "yellow", danger: "red", border: "gray", focusBorder: "magenta", code: "cyan" },
    cool: { accent: "cyan", text: "white", muted: "gray", success: "green", warning: "yellow", danger: "red", border: "blue", focusBorder: "cyan", code: "blue" },
    contrast: { accent: "white", text: "white", muted: "white", success: "white", warning: "white", danger: "white", border: "white", focusBorder: "white", code: "white" },
    mono: { accent: "white", text: "white", muted: "gray", success: "white", warning: "white", danger: "white", border: "gray", focusBorder: "white", code: "white" },
};
/** Resolve a named theme, forcing monochrome for NO_COLOR or non-TTY output. */
export function getTheme(name) {
    if (process.env.NO_COLOR || !process.stdout.isTTY)
        return THEMES.mono;
    return THEMES[name] ?? THEMES.flame;
}
