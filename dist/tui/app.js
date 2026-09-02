import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import React from "react";
import path from "node:path";
import fs from "node:fs";
import fg from "fast-glob";
import { Box, Text, measureElement, useApp, useInput, usePaste, useStdout } from "ink";
import { saveConfig } from "../config.js";
import { AgentSession } from "../agent/session.js";
import { createTools } from "../tools/index.js";
import { decidePermission } from "../security/policy.js";
import { fetchModels } from "../providers/models.js";
import { createDriver } from "../providers/index.js";
import { applyUndo, popUndo } from "../undo.js";
import { inspectLocalModel, listRuntimeSummaries, pullLocalModel } from "../runtime/service.js";
import { startRuntime, stopOwnedRuntime } from "../runtime/process.js";
import { listSessionSummaries, loadSession, newSessionId, saveSession } from "../session.js";
import { memoryPromptSection } from "../memory.js";
import { skillsPromptSection } from "../skills.js";
import { detectProject, loadProjectInstructions } from "../project.js";
import { VERSION } from "../version.js";
import { resolveWorkspacePath } from "../security/workspace.js";
import { estimateCost, estimateMessageTokens, renderUsageStatus } from "../usage.js";
import { loadUsageLedger } from "../usage-store.js";
import { SLASH_COMMANDS } from "../commands/registry.js";
import { executeTuiCommand, tuiCommandSuggestions } from "./commands.js";
import { sanitizeTerminalText, summarizeToolArguments } from "./sanitize.js";
import { getTheme } from "./theme.js";
import { containsPoint, DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, parseMouseInput } from "./mouse.js";
import { formatReaderStatus, wrapReaderText } from "./reader.js";
// A paste this size or larger would make Ink re-wrap and redraw a multi-thousand-
// character single line on every keystroke, which is slow enough to visibly
// corrupt the terminal frame. Collapse it to a placeholder instead.
const PASTE_COLLAPSE_THRESHOLD = 400;
const MAX_PASTE_CHARS = 2_000_000;
export function pastePlaceholder(id, content) {
    const lines = content.split("\n").length;
    return `[Pasted ${content.length.toLocaleString("en-US")} chars, ${lines} line${lines === 1 ? "" : "s"} #${id}]`;
}
/** Replace every known paste placeholder in `value` with its stored full content. */
export function expandPastedBlocks(value, blocks) {
    let result = value;
    for (const [token, content] of blocks)
        result = result.split(token).join(content);
    return result;
}
function systemMessages(config) {
    const root = config.permissions.workspaceRoot;
    const instructions = loadProjectInstructions(root)
        .map((item) => `\n\n[${item.file}]\n${item.content}`).join("");
    // Memory and the skill catalogue are rebuilt here rather than cached, so
    // /new and a workspace switch both pick up the current state.
    return [{
            role: "system",
            content: `You are Forge, a concise AI coding assistant. Work only inside the approved workspace. Use tools when useful.`
                + `${instructions}${memoryPromptSection(root)}${skillsPromptSection(root)}`,
        }];
}
function statusSymbol(status) {
    return status === "completed" ? "✓" : status === "failed" ? "×" : status === "denied" ? "!" : status === "running" ? "●" : "○";
}
export function MessageBlock({ message, theme, maxLines, paneWidth }) {
    const { rows, overflow } = React.useMemo(() => {
        const sanitized = sanitizeTerminalText(message.content);
        const clippedByChars = sanitized.length > 12_000 ? `…[earlier content clipped]\n${sanitized.slice(-12_000)}` : sanitized;
        // Bound how much text we ever hand to the word-wrapper: only the first
        // (maxLines + a margin for mid-word breaks) rows' worth of characters
        // could possibly end up visible, so wrapping further is wasted work —
        // and this component re-renders on every streamed token while busy.
        const charBudget = (maxLines + 5) * paneWidth;
        const budgetTruncated = clippedByChars.length > charBudget;
        const wrapBudget = budgetTruncated ? clippedByChars.slice(0, charBudget) : clippedByChars;
        // Cap by rendered (wrapped) rows, not "\n"-delimited lines: a single very
        // long line with no newlines wraps into many terminal rows on its own and
        // would otherwise ignore a line-count cap entirely, pushing the rest of
        // the workspace layout out of place instead of staying inside its box.
        // Wrapping here ourselves (rather than leaving it to <Text wrap="wrap">)
        // makes the cap exact; each pre-wrapped row is rendered with
        // wrap="truncate-end" as a backstop in case this width estimate is a
        // little off.
        // Content is indented under its role label, so wrap two columns narrower.
        const allRows = wrapReaderText(wrapBudget, Math.max(20, paneWidth - 2));
        const overflow = budgetTruncated ? Math.max(1, allRows.length - maxLines) : allRows.length - maxLines;
        return { rows: overflow > 0 ? allRows.slice(0, maxLines) : allRows, overflow };
    }, [message.content, maxLines, paneWidth]);
    const isUser = message.role === "user";
    const color = isUser ? theme.accent : theme.success;
    return _jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Text, { bold: true, color: color, children: [isUser ? "❯" : "◆", " ", isUser ? "you" : "forge"] }), _jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [rows.map((line, index) => {
                        const code = /^\s{4}|^```/.test(line);
                        const heading = /^#{1,6}\s/.test(line);
                        const bullet = /^\s*[-*•]\s/.test(line);
                        return _jsx(Text, { color: heading ? theme.accent : code ? theme.code : bullet ? theme.text : theme.text, bold: heading, dimColor: !heading && !code && !isUser ? false : undefined, wrap: "truncate-end", children: line || " " }, index);
                    }), overflow > 0 && _jsxs(Text, { color: theme.muted, wrap: "truncate-end", children: ["\u2026 ", overflow, " more line", overflow === 1 ? "" : "s", " \u00B7 ^Y to read it all"] })] })] });
}
// Deliberately drawn with only "_", "/", "\" and spaces: no box-drawing
// characters and no vertical bars, matching the borderless design.
const WORDMARK = [
    "    ____                    ",
    "   / __/___  _________ ____ ",
    "  / /_/ __ \\/ ___/ __ `/ _ \\",
    " / __/ /_/ / /  / /_/ /  __/",
    "/_/  \\____/_/   \\__, /\\___/ ",
    "               /____/       ",
];
// Per-row colours for the wordmark, giving it a vertical gradient. Themes
// that are deliberately monochrome (mono, contrast, NO_COLOR, non-TTY) fall
// back to a single colour rather than forcing colour where it isn't wanted.
const WORDMARK_GRADIENTS = {
    magenta: ["#ff7ab8", "#ff5fa8", "#f45d9e", "#d95dc4", "#b45ce0", "#8f5bf0"],
    cyan: ["#7fe7ff", "#4fd8ff", "#26c6ff", "#12aaff", "#0a8bf5", "#0d6fe0"],
};
/**
 * Shown whenever a session has no conversation yet — a fresh start, /new, or
 * a cleared history. Degrades by available height: the wordmark and the
 * session summary each drop out before the essentials do, so this can never
 * be what pushes the frame past the terminal.
 */
function WelcomeScreen({ theme, config, profile, height, hasResumable }) {
    const project = React.useMemo(() => detectProject(config.permissions.workspaceRoot), [config.permissions.workspaceRoot]);
    const instructions = React.useMemo(() => loadProjectInstructions(config.permissions.workspaceRoot), [config.permissions.workspaceRoot]);
    const workspace = path.basename(config.permissions.workspaceRoot);
    const showWordmark = height >= 17;
    const showSummary = height >= 12;
    const gradient = WORDMARK_GRADIENTS[theme.accent];
    const facts = [
        ["workspace", [workspace, ...project.languages, project.git ? "git" : undefined, project.packageManager].filter(Boolean).join(" · "), theme.accent],
        ["model", `${config.activeProfile}/${profile.model} · ${profile.kind === "local" ? "local" : "cloud"}${config.routing.offline ? " · offline" : ""}`, theme.success],
        ["mode", config.permissions.mode === "autonomous" ? "autonomous · tools run without asking" : config.permissions.mode === "read-only" ? "read-only · writes are blocked" : "balanced · asks before writing or running",
            config.permissions.mode === "autonomous" ? theme.warning : theme.muted],
    ];
    if (instructions.length)
        facts.push(["context", `${instructions.map((item) => item.file).join(", ")} loaded`, theme.code]);
    return _jsxs(Box, { flexDirection: "column", alignItems: "center", justifyContent: "center", flexGrow: 1, children: [showWordmark && _jsx(Box, { flexDirection: "column", children: WORDMARK.map((line, index) => (_jsx(Text, { color: gradient ? gradient[index] ?? gradient.at(-1) : theme.accent, bold: true, children: line }, index))) }), !showWordmark && _jsx(Text, { color: theme.accent, bold: true, children: "\u25C6 forge" }), _jsxs(Box, { marginTop: showWordmark ? 1 : 0, children: [_jsx(Text, { color: theme.muted, dimColor: true, children: "local-first coding agent" }), _jsx(Text, { color: theme.muted, dimColor: true, children: " \u00B7 " }), _jsxs(Text, { color: theme.accent, children: ["v", VERSION] })] }), showSummary && _jsx(Box, { flexDirection: "column", marginTop: 1, children: facts.map(([label, value, colour]) => _jsxs(Box, { children: [_jsx(Text, { color: colour, children: "\u25C6 " }), _jsx(Box, { width: 11, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: label }) }), _jsx(Text, { color: theme.text, wrap: "truncate-end", children: sanitizeTerminalText(value) })] }, label)) }), _jsxs(Box, { marginTop: 1, flexDirection: "column", alignItems: "center", children: [_jsxs(Text, { color: theme.muted, children: ["describe what you want to build, or press ", _jsx(Text, { color: theme.accent, bold: true, children: "?" }), " for help"] }), hasResumable && _jsxs(Text, { color: theme.muted, dimColor: true, children: ["press ", _jsx(Text, { color: theme.accent, children: "^S" }), " to pick up your last session"] })] })] });
}
/**
 * Full-screen frame shell shared by every modal-like view (overlay lists,
 * approval, key entry, the reader). Replacing the chat view outright — rather
 * than layering a partially-transparent box on top of it — is deliberate:
 * Ink has no real background fill, so a floating box over live content lets
 * conversation text bleed through the gaps and around the edges, which reads
 * as visual noise stacked on top of the modal's own text.
 */
function Frame({ dimensions, title, titleColor, footer, children }) {
    return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, overflow: "hidden", paddingX: 2, paddingY: 1, children: [_jsxs(Text, { bold: true, inverse: true, color: titleColor, children: [" ", title, " "] }), _jsx(Text, { children: " " }), _jsx(Box, { flexDirection: "column", flexGrow: 1, children: children }), footer && _jsx(Text, { color: "gray", children: footer })] });
}
function Overlay({ dimensions, title, query, items, selected, theme, footer, itemRefs }) {
    const visibleCount = Math.max(6, dimensions.rows - 9);
    const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), Math.max(0, items.length - visibleCount)));
    return _jsx(Frame, { dimensions: dimensions, title: `FORGE · ${title}`, titleColor: theme.accent, footer: footer, children: _jsxs(Box, { flexDirection: "column", flexGrow: 1, children: [_jsxs(Text, { color: theme.text, children: ["Search: ", sanitizeTerminalText(query), "\u2588"] }), _jsx(Text, { color: theme.muted, children: "─".repeat(Math.min(70, dimensions.columns - 4)) }), items.slice(start, start + visibleCount).map((item, index) => {
                    const absolute = start + index;
                    return _jsx(Box, { ref: (node) => { if (node)
                            itemRefs?.current.set(absolute, node);
                        else
                            itemRefs?.current.delete(absolute); }, children: _jsxs(Text, { color: absolute === selected ? theme.accent : theme.text, inverse: absolute === selected, wrap: "truncate-end", children: [absolute === selected ? " › " : "   ", sanitizeTerminalText(item.label), item.detail ? `  ${sanitizeTerminalText(item.detail)}` : ""] }) }, item.id);
                }), !items.length && _jsx(Text, { color: theme.muted, children: "No items available." })] }) });
}
function DiffPreview({ diff, theme, maxLines }) {
    const lines = diff.split("\n");
    const visible = lines.slice(0, maxLines);
    return _jsxs(Box, { flexDirection: "column", children: [visible.map((line, index) => {
                const color = line.startsWith("+") && !line.startsWith("+++") ? theme.success
                    : line.startsWith("-") && !line.startsWith("---") ? theme.danger
                        : line.startsWith("@@") ? theme.accent
                            : theme.muted;
                return _jsx(Text, { color: color, wrap: "truncate-end", children: line || " " }, index);
            }), lines.length > maxLines && _jsxs(Text, { color: theme.muted, children: ["\u2026", lines.length - maxLines, " more line(s) not shown"] })] });
}
function ApprovalModal({ dimensions, state, choice, theme, allowRef, denyRef }) {
    const args = summarizeToolArguments(state.request.activity.args);
    const diff = state.request.activity.diff;
    return _jsxs(Frame, { dimensions: dimensions, title: `APPROVAL REQUIRED · ${state.request.activity.risk.toUpperCase()}`, titleColor: theme.warning, footer: "\u2190/\u2192 or Tab to choose, Enter to confirm \u00B7 Y allows \u00B7 N/Esc denies", children: [_jsx(Text, { bold: true, children: state.request.activity.name }), _jsx(Text, { color: theme.muted, wrap: "wrap", children: args }), _jsx(Text, { children: " " }), diff && _jsx(DiffPreview, { diff: diff, theme: theme, maxLines: Math.max(4, dimensions.rows - 16) }), diff && _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Box, { ref: allowRef, children: _jsx(Text, { color: theme.success, inverse: choice === "allow", bold: choice === "allow", children: choice === "allow" ? "› [ Allow once ]" : "  [ Allow once ]" }) }), _jsx(Box, { ref: denyRef, children: _jsx(Text, { color: theme.danger, inverse: choice === "deny", bold: choice === "deny", children: choice === "deny" ? "› [ Deny ]" : "  [ Deny ]" }) })] }), _jsx(Text, { children: " " }), _jsx(Text, { color: theme.muted, wrap: "wrap", children: "Mouse clicks need capture mode on (Ctrl+T); the keyboard always works here." })] });
}
function KeyEntryModal({ dimensions, name, mode, draft, theme }) {
    return _jsxs(Frame, { dimensions: dimensions, title: mode === "add" ? `NEW PROVIDER · ${name}` : `UPDATE KEY · ${name}`, titleColor: theme.accent, footer: "Enter to save \u00B7 Esc to cancel", children: [_jsx(Text, { color: theme.muted, wrap: "wrap", children: "Paste or type the API key. It is masked here and never added to composer history." }), _jsx(Text, { children: " " }), _jsxs(Text, { color: theme.text, children: ["•".repeat(draft.length), "\u2588"] })] });
}
/** Render Forge's responsive, keyboard-first full-screen terminal workspace. */
// Never render to the terminal's literal last column. Many terminal
// emulators implement "pending wrap": writing a cell in the final column
// doesn't wrap until the *next* character arrives, leaving the cursor in an
// ambiguous state until then. Ink and the terminal can disagree about
// exactly where the cursor is while that's pending, especially across the
// rapid, repeated cursor-repositioning escape sequences a redraw-heavy
// full-screen app produces — a documented category of cross-terminal
// desync. Forge's boxes are sized to the full reported width, so this
// reserves one column as a safety margin against that class of bug.
function readTerminalSize(stdout) {
    return { columns: Math.max(40, (stdout.columns ?? 121) - 1), rows: stdout.rows ?? 30 };
}
export function ForgeTui({ config }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [dimensions, setDimensions] = React.useState(() => readTerminalSize(stdout));
    const [input, setInput] = React.useState("");
    const [cursor, setCursor] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const [streamText, setStreamText] = React.useState("");
    const [revision, setRevision] = React.useState(0);
    const [notice, setNotice] = React.useState("Ready");
    const [activities, setActivities] = React.useState([]);
    const [approval, setApproval] = React.useState(null);
    const [approvalChoice, setApprovalChoice] = React.useState("deny");
    const [keyEntry, setKeyEntry] = React.useState(null);
    const [overlay, setOverlay] = React.useState(null);
    const [overlayQuery, setOverlayQuery] = React.useState("");
    const [overlayItems, setOverlayItems] = React.useState([]);
    const [selected, setSelected] = React.useState(0);
    const [focus, setFocus] = React.useState("composer");
    const [selectedActivity, setSelectedActivity] = React.useState(0);
    const [reader, setReader] = React.useState(null);
    const [readerOffset, setReaderOffset] = React.useState(0);
    const [scrollOffset, setScrollOffset] = React.useState(0);
    const [queuedPrompt, setQueuedPrompt] = React.useState("");
    const [usage, setUsage] = React.useState({ promptTokens: 0, completionTokens: 0 });
    const [subscriptionTokensUsed, setSubscriptionTokensUsed] = React.useState(() => {
        const entry = loadUsageLedger().profiles[config.activeProfile];
        return entry ? entry.promptTokens + entry.completionTokens : 0;
    });
    const [pricing, setPricing] = React.useState();
    // Read once at startup: the welcome screen only mentions this to offer
    // picking up where the last run left off, and it shouldn't hit the disk on
    // every render to do it.
    const [hasResumableSession] = React.useState(() => {
        try {
            return listSessionSummaries().length > 0;
        }
        catch {
            return false;
        }
    });
    // Every run gets an id up front, so its autosaves land in their own file
    // and stay resumable instead of all runs sharing one "autosave" slot.
    const sessionIdRef = React.useRef(newSessionId());
    const contextFilesRef = React.useRef(new Map());
    const pastedBlocksRef = React.useRef(new Map());
    const pasteCounterRef = React.useRef(0);
    const approvalRef = React.useRef(null);
    const queuedPromptRef = React.useRef("");
    const streamBufferRef = React.useRef("");
    const streamFlushTimerRef = React.useRef(null);
    const operationAbortRef = React.useRef(null);
    const messagesRef = React.useRef(systemMessages(config));
    const sessionRef = React.useRef(null);
    const conversationPaneRef = React.useRef(null);
    const composerRef = React.useRef(null);
    const approvalAllowRef = React.useRef(null);
    const approvalDenyRef = React.useRef(null);
    const overlayItemRefs = React.useRef(new Map());
    const activityItemRefs = React.useRef(new Map());
    const commandButtonRef = React.useRef(null);
    const filesButtonRef = React.useRef(null);
    const modelsButtonRef = React.useRef(null);
    const sessionsButtonRef = React.useRef(null);
    const helpButtonRef = React.useRef(null);
    const modeButtonRef = React.useRef(null);
    const readerButtonRef = React.useRef(null);
    const theme = getTheme(config.ui.theme);
    React.useEffect(() => {
        if (!config.ui.mouse || !stdout.isTTY)
            return;
        stdout.write(ENABLE_MOUSE_TRACKING);
        return () => { stdout.write(DISABLE_MOUSE_TRACKING); };
    }, [config.ui.mouse, stdout]);
    const requestApproval = React.useCallback((request) => new Promise((resolve) => {
        const value = { request, resolve };
        approvalRef.current = value;
        setApproval(value);
        setApprovalChoice("deny");
    }), []);
    if (!sessionRef.current) {
        sessionRef.current = new AgentSession({
            config,
            messages: messagesRef.current,
            usage,
            getContextMessages: () => {
                const pinned = Array.from(contextFilesRef.current, ([file, content]) => `[Pinned file: ${file}]\n${content}`).join("\n\n");
                return pinned ? [...messagesRef.current, { role: "system", content: `Pinned workspace context:\n${pinned}` }] : messagesRef.current;
            },
            approve: requestApproval,
        });
    }
    const session = sessionRef.current;
    const flushQueuedPrompt = React.useCallback(() => {
        const queued = queuedPromptRef.current;
        if (!queued)
            return;
        queuedPromptRef.current = "";
        setQueuedPrompt("");
        setTimeout(() => { void session.send(queued); }, 0);
    }, [session]);
    React.useEffect(() => {
        const resize = () => setDimensions(readTerminalSize(stdout));
        stdout.on("resize", resize);
        return () => { stdout.off("resize", resize); };
    }, [stdout]);
    const clearStreamBuffer = React.useCallback(() => {
        if (streamFlushTimerRef.current) {
            clearTimeout(streamFlushTimerRef.current);
            streamFlushTimerRef.current = null;
        }
        streamBufferRef.current = "";
    }, []);
    React.useEffect(() => {
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "turn.started") {
                clearStreamBuffer();
                setBusy(true);
                setStreamText("");
                setNotice("Thinking…");
                setRevision((value) => value + 1);
            }
            else if (event.type === "text.delta") {
                // A fast provider can emit far more deltas per second than the terminal
                // can usefully redraw; batch them into one state update roughly every
                // 50ms instead of re-rendering (and regenerating/writing the full
                // frame) on every single token.
                streamBufferRef.current += event.delta;
                if (!streamFlushTimerRef.current) {
                    streamFlushTimerRef.current = setTimeout(() => {
                        streamFlushTimerRef.current = null;
                        const pending = streamBufferRef.current;
                        streamBufferRef.current = "";
                        if (pending)
                            setStreamText((value) => value + pending);
                    }, 50);
                }
            }
            else if (event.type === "message.completed") {
                clearStreamBuffer();
                setStreamText("");
                saveSession(sessionIdRef.current, messagesRef.current);
                setRevision((value) => value + 1);
            }
            else if (event.type === "tool.requested")
                setActivities((items) => [event.activity, ...items.filter((item) => item.id !== event.activity.id)].slice(0, 20));
            else if (event.type === "tool.updated")
                setActivities((items) => [event.activity, ...items.filter((item) => item.id !== event.activity.id)].slice(0, 20));
            else if (event.type === "usage.updated") {
                setUsage({ ...event.usage });
                const entry = loadUsageLedger().profiles[config.activeProfile];
                setSubscriptionTokensUsed(entry ? entry.promptTokens + entry.completionTokens : 0);
            }
            else if (event.type === "turn.failed") {
                const pending = streamBufferRef.current;
                clearStreamBuffer();
                if (pending)
                    setStreamText((value) => value + pending);
                setBusy(false);
                setNotice(`Error: ${sanitizeTerminalText(event.error.message)}`);
            }
            else if (event.type === "turn.cancelled") {
                const pending = streamBufferRef.current;
                clearStreamBuffer();
                if (pending)
                    setStreamText((value) => value + pending);
                setBusy(false);
                setNotice("Cancelled");
            }
            else if (event.type === "turn.completed") {
                setBusy(false);
                setNotice("Ready");
                setRevision((value) => value + 1);
                flushQueuedPrompt();
            }
        });
        return () => { unsubscribe(); clearStreamBuffer(); };
    }, [clearStreamBuffer, flushQueuedPrompt, session]);
    React.useEffect(() => {
        fetchModels(config.profiles[config.activeProfile]).then((models) => {
            setPricing(models.find((model) => model.id === config.profiles[config.activeProfile].model));
        }).catch(() => undefined);
    }, [config.activeProfile, config.profiles]);
    React.useEffect(() => {
        const entry = loadUsageLedger().profiles[config.activeProfile];
        setSubscriptionTokensUsed(entry ? entry.promptTokens + entry.completionTokens : 0);
    }, [config.activeProfile]);
    React.useEffect(() => {
        setSelected(0);
        setOverlayQuery("");
        if (!overlay) {
            setOverlayItems([]);
            return;
        }
        if (overlay === "help" || overlay === "commands") {
            setOverlayItems(SLASH_COMMANDS.map((command) => ({ id: command.name, label: command.usage, detail: command.description })));
        }
        else if (overlay === "models") {
            setOverlayItems(Object.entries(config.profiles).map(([name, profile]) => ({ id: `profile:${name}`, label: `${name}: ${profile.model}`, detail: profile.kind })));
            listRuntimeSummaries(config).then((summaries) => setOverlayItems((items) => [
                ...items,
                ...summaries.flatMap((runtime) => runtime.models.map((model) => ({ id: `${runtime.kind}:${model.id}`, label: `${runtime.kind}:${model.id}`, detail: runtime.health.healthy ? "local · online" : "local · offline" }))),
            ])).catch(() => undefined);
        }
        else if (overlay === "context") {
            fg("**/*", { cwd: config.permissions.workspaceRoot, onlyFiles: true, dot: false, ignore: [".git/**", "node_modules/**", "dist/**"] })
                .then((files) => setOverlayItems(files.slice(0, 500).map((file) => ({ id: file, label: file, detail: contextFilesRef.current.has(file) ? "pinned" : undefined })))).catch(() => setOverlayItems([]));
        }
        else if (overlay === "sessions") {
            // Newest first, with the first thing asked as the label so a session is
            // recognisable, and the id kept as the detail for /load.
            setOverlayItems(listSessionSummaries().map((entry) => ({
                id: entry.id,
                label: entry.title,
                detail: `${entry.messageCount} msg · ${entry.updatedAt.slice(0, 16).replace("T", " ")} · ${entry.id}`,
            })));
        }
    }, [overlay, config]);
    const filteredOverlayItems = React.useMemo(() => {
        const query = overlayQuery.trim().toLowerCase();
        if (!query)
            return overlayItems;
        return overlayItems.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query));
    }, [overlayItems, overlayQuery]);
    const cyclePermissionMode = React.useCallback(() => {
        const order = ["read-only", "balanced", "autonomous"];
        config.permissions.mode = order[(order.indexOf(config.permissions.mode) + 1) % order.length];
        saveConfig(config);
        setNotice(`Permission mode set to ${config.permissions.mode}.`);
        setRevision((value) => value + 1);
    }, [config]);
    const closeApproval = React.useCallback((allowed) => {
        const current = approvalRef.current;
        if (!current)
            return;
        approvalRef.current = null;
        setApproval(null);
        if (allowed && ["write", "process", "external"].includes(current.request.activity.risk)) {
            saveSession("recovery-latest", messagesRef.current);
        }
        current.resolve(allowed);
    }, []);
    const selectOverlayItem = React.useCallback((selection = selected) => {
        const item = filteredOverlayItems[selection];
        if (!item || !overlay)
            return;
        if (overlay === "commands" || overlay === "help") {
            setInput(`/${item.id} `);
            setCursor(item.id.length + 2);
            setOverlay(null);
        }
        else if (overlay === "models") {
            if (item.id.startsWith("profile:"))
                config.activeProfile = item.id.slice(8);
            else {
                const runtime = item.id.slice(0, item.id.indexOf(":"));
                const model = item.id.slice(item.id.indexOf(":") + 1);
                const name = `local-${runtime}`;
                const runtimeConfig = config.runtimes[runtime];
                config.profiles[name] = { kind: "local", runtime: runtime, baseURL: runtimeConfig.baseURL, apiKey: runtime === "ollama" ? "ollama" : "local", format: "openai", model };
                config.activeProfile = name;
            }
            saveConfig(config);
            setNotice(`Using ${config.activeProfile}: ${config.profiles[config.activeProfile].model}`);
            setOverlay(null);
            setRevision((value) => value + 1);
        }
        else if (overlay === "context") {
            try {
                const full = resolveWorkspacePath(config.permissions.workspaceRoot, item.id);
                contextFilesRef.current.set(item.id, fs.readFileSync(full, "utf-8").slice(0, 48_000));
                setNotice(`Pinned ${item.id}`);
                setOverlay(null);
                setRevision((value) => value + 1);
            }
            catch (error) {
                setNotice(`Could not pin file: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        else if (overlay === "sessions") {
            try {
                messagesRef.current.splice(0, messagesRef.current.length, ...loadSession(item.id));
                // Adopt the loaded session's id so continuing the conversation saves
                // back into it rather than forking into the id this run started with.
                sessionIdRef.current = item.id;
                setNotice(`Resumed ${item.id}`);
                setOverlay(null);
                setRevision((value) => value + 1);
            }
            catch {
                setNotice(`Could not load ${item.id}`);
            }
        }
    }, [config, filteredOverlayItems, overlay, selected]);
    const finishKeyEntry = React.useCallback((cancelled) => {
        setKeyEntry((current) => {
            if (!current)
                return null;
            if (cancelled) {
                setNotice(current.mode === "add" ? "Provider setup cancelled." : "Key entry cancelled.");
                return null;
            }
            if (!current.draft) {
                setNotice("No key entered — nothing changed.");
                return null;
            }
            try {
                config.profiles[current.name] = { baseURL: current.baseURL, apiKey: current.draft, format: current.format, model: current.model, kind: "remote" };
                saveConfig(config);
                setNotice(current.mode === "add" ? `Provider "${current.name}" added.` : `API key updated for "${current.name}".`);
                setRevision((value) => value + 1);
            }
            catch (error) {
                setNotice(`Could not save provider: ${error instanceof Error ? error.message : String(error)}`);
            }
            return null;
        });
    }, [config]);
    const submit = React.useCallback(async () => {
        const trimmed = input.trim();
        if (!trimmed)
            return;
        const value = expandPastedBlocks(trimmed, pastedBlocksRef.current);
        pastedBlocksRef.current.clear();
        setInput("");
        setCursor(0);
        setScrollOffset(0);
        if (busy) {
            queuedPromptRef.current = value;
            setQueuedPrompt(value);
            setNotice("Prompt queued for the next turn");
            return;
        }
        let command;
        try {
            command = executeTuiCommand(value, {
                config,
                messages: messagesRef.current,
                contextFiles: contextFilesRef.current,
                persist: () => saveConfig(config),
                setWorkspace(workspace) {
                    config.permissions.workspaceRoot = workspace;
                    contextFilesRef.current.clear();
                    messagesRef.current.splice(0, messagesRef.current.length, ...systemMessages(config));
                    saveConfig(config);
                },
            });
        }
        catch (error) {
            setNotice(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
            setRevision((revision) => revision + 1);
            return;
        }
        if (command.type === "provider-add") {
            setKeyEntry({ mode: "add", name: command.name, baseURL: command.baseURL, format: command.format, model: command.model, draft: "" });
            return;
        }
        if (command.type === "key-update") {
            const existing = config.profiles[command.name];
            setKeyEntry({ mode: "update", name: command.name, baseURL: existing.baseURL, format: existing.format, model: existing.model, draft: "" });
            return;
        }
        if (command.type === "exit") {
            exit();
            return;
        }
        if (command.type === "overlay") {
            setOverlay(command.overlay);
            return;
        }
        if (command.type === "notice") {
            setNotice(command.message);
            setRevision((revision) => revision + 1);
            return;
        }
        if (command.type === "clear") {
            messagesRef.current.splice(0, messagesRef.current.length, ...systemMessages(config));
            setActivities([]);
            setNotice("New conversation");
            setRevision((revision) => revision + 1);
            return;
        }
        if (command.type === "load") {
            messagesRef.current.splice(0, messagesRef.current.length, ...command.messages);
            sessionIdRef.current = command.name;
            setNotice(`Resumed ${command.name}`);
            setRevision((revision) => revision + 1);
            return;
        }
        if (command.type === "undo") {
            const entry = popUndo(config.permissions.workspaceRoot);
            if (!entry) {
                setNotice("Nothing to undo.");
                return;
            }
            try {
                const touched = applyUndo(config.permissions.workspaceRoot, entry);
                setNotice(`Undid ${entry.tool}: ${touched.join(", ")}.`);
            }
            catch (error) {
                setNotice(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            setRevision((value) => value + 1);
            return;
        }
        if (command.type === "compact") {
            const history = messagesRef.current.filter((message) => message.role !== "system");
            if (history.length < 2) {
                setNotice("Nothing to compact yet.");
                return;
            }
            setBusy(true);
            setNotice("Compacting conversation…");
            operationAbortRef.current = new AbortController();
            try {
                const driver = createDriver(profile);
                let summary = "";
                let failure;
                await driver.streamChat([...history, { role: "user", content: "Summarize this entire conversation concisely but completely: the goal, key decisions, code or file changes made, current state, and any open next steps. Write it as a standalone note — it will fully replace this conversation's history to free up context, so do not omit anything a continuation would need." }], [], profile.model, { onTextDelta: (delta) => { summary += delta; }, onToolCallsComplete: () => { }, onDone: () => { }, onError: (error) => { failure = error; } }, operationAbortRef.current.signal);
                if (failure)
                    throw failure;
                const before = estimateMessageTokens(messagesRef.current);
                messagesRef.current.splice(0, messagesRef.current.length, ...systemMessages(config), { role: "assistant", content: `[Conversation compacted from ${history.length} messages]\n\n${summary.trim()}` });
                const after = estimateMessageTokens(messagesRef.current);
                setNotice(`Compacted ${history.length} messages (~${before.toLocaleString("en-US")} → ~${after.toLocaleString("en-US")} tokens).`);
            }
            catch (error) {
                setNotice(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                operationAbortRef.current = null;
                setBusy(false);
                setRevision((value) => value + 1);
                flushQueuedPrompt();
            }
            return;
        }
        if (command.type === "model-info") {
            setBusy(true);
            setNotice(`Inspecting ${command.reference}…`);
            try {
                const capabilities = await inspectLocalModel(config, command.reference);
                setNotice(`${command.reference}: ${Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name).join(", ") || "chat"}`);
            }
            catch (error) {
                setNotice(`Model inspection failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                setBusy(false);
                flushQueuedPrompt();
            }
            return;
        }
        if (command.type === "model-pull") {
            const allowed = await requestApproval({
                call: { id: `pull-${Date.now()}`, name: "model_pull", arguments: JSON.stringify({ reference: command.reference }) },
                activity: { id: `pull-${Date.now()}`, name: "model_pull", risk: "external", status: "waiting", args: { reference: command.reference }, startedAt: Date.now() },
            });
            if (!allowed) {
                setNotice("Model download denied.");
                return;
            }
            setBusy(true);
            operationAbortRef.current = new AbortController();
            try {
                for await (const progress of pullLocalModel(config, command.reference, operationAbortRef.current.signal)) {
                    const percent = progress.total && progress.completed ? ` ${Math.floor((progress.completed / progress.total) * 100)}%` : "";
                    setNotice(`${progress.status}${percent}`);
                }
                setNotice(`Downloaded ${command.reference}.`);
            }
            catch (error) {
                setNotice(`Model download failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                operationAbortRef.current = null;
                setBusy(false);
                flushQueuedPrompt();
            }
            return;
        }
        if (command.type === "runtime") {
            if (command.operation === "list" || command.operation === "status") {
                setBusy(true);
                try {
                    const summaries = await listRuntimeSummaries(config);
                    setNotice(summaries.map((item) => `${item.kind} ${item.health.healthy ? "online" : "offline"} (${item.models.length})`).join(" · "));
                }
                catch (error) {
                    setNotice(`Runtime status failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                finally {
                    setBusy(false);
                    flushQueuedPrompt();
                }
                return;
            }
            if (!command.kind || !(command.kind in config.runtimes)) {
                setNotice("Usage: /runtime start|stop <ollama|lmstudio|llamacpp|openai-compatible> [model-path]");
                return;
            }
            const allowed = await requestApproval({
                call: { id: `runtime-${Date.now()}`, name: `runtime_${command.operation}`, arguments: JSON.stringify({ kind: command.kind, modelPath: command.modelPath }) },
                activity: { id: `runtime-${Date.now()}`, name: `runtime_${command.operation}`, risk: "process", status: "waiting", args: { kind: command.kind, modelPath: command.modelPath }, startedAt: Date.now() },
            });
            if (!allowed) {
                setNotice("Runtime operation denied.");
                return;
            }
            setBusy(true);
            try {
                if (command.operation === "start") {
                    const result = await startRuntime(config, command.kind, { modelPath: command.modelPath });
                    setNotice(result.owned ? `Started ${command.kind} (PID ${result.pid}).` : `${command.kind} is already online.`);
                }
                else {
                    await stopOwnedRuntime(config, command.kind);
                    setNotice(`Stopped ${command.kind}.`);
                }
            }
            catch (error) {
                setNotice(`Runtime operation failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                setBusy(false);
                flushQueuedPrompt();
            }
            return;
        }
        if (command.type === "tool" || command.type === "tool-sequence") {
            const requestedTools = command.type === "tool" ? [{ name: command.name, args: command.args }] : command.tools;
            setBusy(true);
            operationAbortRef.current = new AbortController();
            try {
                for (let index = 0; index < requestedTools.length; index += 1) {
                    const requested = requestedTools[index];
                    const tool = createTools({ workspaceRoot: config.permissions.workspaceRoot }).find((item) => item.def.name === requested.name);
                    if (!tool) {
                        setNotice(`Tool ${requested.name} is unavailable.`);
                        break;
                    }
                    const decision = decidePermission(config.permissions.mode, tool.risk);
                    if (decision === "deny") {
                        setNotice(`${config.permissions.mode} mode blocks ${tool.risk} tools.`);
                        break;
                    }
                    if (decision === "ask") {
                        const id = `command-${Date.now()}-${index}`;
                        let diff;
                        try {
                            diff = tool.preview?.(requested.args);
                        }
                        catch { /* preview is best-effort */ }
                        const allowed = await requestApproval({
                            call: { id, name: tool.def.name, arguments: JSON.stringify(requested.args) },
                            activity: { id, name: tool.def.name, risk: tool.risk, status: "waiting", args: requested.args, diff, startedAt: Date.now() },
                        });
                        if (!allowed) {
                            setNotice("Command denied.");
                            break;
                        }
                    }
                    const activity = { id: `command-${Date.now()}-${index}`, name: tool.def.name, risk: tool.risk, status: "running", args: requested.args, startedAt: Date.now() };
                    setActivities((items) => [activity, ...items].slice(0, 20));
                    try {
                        setNotice(requestedTools.length > 1 ? `Check ${index + 1}/${requestedTools.length}: ${tool.def.name}` : `Running ${tool.def.name}...`);
                        const result = await tool.execute(requested.args, operationAbortRef.current.signal);
                        activity.status = "completed";
                        activity.result = result;
                        activity.durationMs = Date.now() - activity.startedAt;
                        messagesRef.current.push({ role: "assistant", content: `Command output (${tool.def.name}):\n${result}` });
                        setNotice(requestedTools.length > 1 ? `Check ${index + 1}/${requestedTools.length} completed.` : `${tool.def.name} completed.`);
                    }
                    catch (error) {
                        activity.status = "failed";
                        activity.result = error instanceof Error ? error.message : String(error);
                        activity.durationMs = Date.now() - activity.startedAt;
                        setNotice(`${tool.def.name} failed: ${activity.result}`);
                        break;
                    }
                    finally {
                        setActivities((items) => [{ ...activity }, ...items.filter((item) => item.id !== activity.id)].slice(0, 20));
                    }
                }
            }
            finally {
                operationAbortRef.current = null;
                setBusy(false);
                setRevision((revision) => revision + 1);
                flushQueuedPrompt();
            }
            return;
        }
        try {
            await session.send(command.type === "prompt" ? command.prompt : value);
        }
        catch (error) {
            setBusy(false);
            setNotice(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [busy, config, exit, flushQueuedPrompt, input, requestApproval, session]);
    const openReader = React.useCallback((pane = focus) => {
        let title;
        let content;
        if (pane === "activity") {
            title = "ACTIVITY";
            const selectedItem = activities[selectedActivity];
            content = selectedItem
                ? `${selectedItem.name}\nstatus: ${selectedItem.status}\nrisk: ${selectedItem.risk}\nduration: ${selectedItem.durationMs ?? "pending"} ms\narguments: ${JSON.stringify(selectedItem.args, null, 2)}\n\n${selectedItem.result ?? "No result available."}`
                : activities.map((item) => `${statusSymbol(item.status)} ${item.name} · ${item.status}${item.durationMs != null ? ` · ${item.durationMs} ms` : ""}`).join("\n") || "No tool activity yet.";
        }
        else if (pane === "context") {
            title = "CONTEXT / SESSION";
            const pinned = Array.from(contextFilesRef.current, ([file, value]) => `${file} (${value.length} chars)`).join("\n") || "No pinned files.";
            content = `SESSION\n${busy ? "Working" : "Ready"}\n\nLATEST STATUS / ERROR\n${formatReaderStatus(notice)}\n\nWORKSPACE\n${config.permissions.workspaceRoot}\n\nPINNED FILES\n${pinned}`;
        }
        else if (pane === "composer") {
            title = "COMPOSER";
            content = input || "The composer is empty.";
        }
        else {
            title = "CONVERSATION";
            content = messagesRef.current.filter((message) => message.role !== "system").map((message) => `${message.role === "user" ? "YOU" : message.role === "assistant" ? "FORGE" : `TOOL ${message.name ?? "RESULT"}`}\n\n${message.content}`).join("\n\n---\n\n") || "No conversation messages yet.";
            if (streamText)
                content += `${content ? "\n\n---\n\n" : ""}FORGE (streaming)\n\n${streamText}`;
        }
        if (config.ui.mouse) {
            config.ui.mouse = false;
            saveConfig(config);
        }
        setReader({ title, content: sanitizeTerminalText(content) });
        setReaderOffset(0);
        setRevision((value) => value + 1);
    }, [activities, busy, config, focus, input, notice, selectedActivity, streamText]);
    // Shared by useInput's fallback branch and usePaste below: route pasted
    // text to whichever surface is actually active, and collapse a large
    // composer paste to a placeholder so it never has to be rendered inline.
    const insertPastedText = React.useCallback((text) => {
        if (reader || approval)
            return;
        if (keyEntry) {
            setKeyEntry((current) => current && { ...current, draft: current.draft + text });
            return;
        }
        if (overlay) {
            setOverlayQuery((value) => value + text);
            setSelected(0);
            return;
        }
        if (text.length > PASTE_COLLAPSE_THRESHOLD) {
            const content = text.length > MAX_PASTE_CHARS ? `${text.slice(0, MAX_PASTE_CHARS)}\n[…truncated, pasted content exceeded ${MAX_PASTE_CHARS.toLocaleString("en-US")} characters]` : text;
            const token = pastePlaceholder(++pasteCounterRef.current, content);
            pastedBlocksRef.current.set(token, content);
            setInput((value) => value.slice(0, cursor) + token + value.slice(cursor));
            setCursor((value) => value + token.length);
            setNotice(`Pasted ${content.length.toLocaleString("en-US")} characters — kept as a placeholder so the composer stays responsive.`);
            setRevision((value) => value + 1);
            return;
        }
        setInput((value) => value.slice(0, cursor) + text + value.slice(cursor));
        setCursor((value) => value + text.length);
    }, [reader, approval, keyEntry, overlay, cursor]);
    useInput((character, key) => {
        if (reader) {
            const readerLines = wrapReaderText(reader.content, dimensions.columns);
            const page = Math.max(1, dimensions.rows - 3);
            if (key.ctrl && character === "c") {
                exit();
                return;
            }
            if (key.escape || (key.ctrl && character === "y")) {
                setReader(null);
                setReaderOffset(0);
                return;
            }
            if (key.pageUp || key.upArrow) {
                setReaderOffset((value) => Math.max(0, value - (key.pageUp ? page : 1)));
                return;
            }
            if (key.pageDown || key.downArrow) {
                setReaderOffset((value) => Math.min(Math.max(0, readerLines.length - page), value + (key.pageDown ? page : 1)));
                return;
            }
            if (key.home) {
                setReaderOffset(0);
                return;
            }
            if (key.end) {
                setReaderOffset(Math.max(0, readerLines.length - page));
                return;
            }
            return;
        }
        if (keyEntry) {
            if (key.ctrl && character === "c") {
                exit();
                return;
            }
            if (key.escape) {
                finishKeyEntry(true);
                return;
            }
            if (key.return) {
                finishKeyEntry(false);
                return;
            }
            if (key.backspace || key.delete) {
                setKeyEntry((current) => current && { ...current, draft: current.draft.slice(0, -1) });
                return;
            }
            if (!key.ctrl && !key.meta && character) {
                setKeyEntry((current) => current && { ...current, draft: current.draft + character });
            }
            return;
        }
        const mouse = config.ui.mouse ? parseMouseInput(character) : undefined;
        if (mouse) {
            const metrics = (ref) => ref.current ? measureElement(ref.current) : undefined;
            if (approval) {
                if (mouse.action === "press" && mouse.button === "left") {
                    if (containsPoint(metrics(approvalAllowRef), mouse.x, mouse.y))
                        closeApproval(true);
                    else if (containsPoint(metrics(approvalDenyRef), mouse.x, mouse.y))
                        closeApproval(false);
                }
                return;
            }
            if (overlay) {
                if (mouse.action === "wheel") {
                    setSelected((value) => Math.max(0, Math.min(filteredOverlayItems.length - 1, value + (mouse.button === "wheel-down" ? 1 : -1))));
                }
                else if (mouse.action === "press" && mouse.button === "left") {
                    for (const [index, node] of overlayItemRefs.current) {
                        if (containsPoint(measureElement(node), mouse.x, mouse.y)) {
                            setSelected(index);
                            selectOverlayItem(index);
                            return;
                        }
                    }
                }
                return;
            }
            if (mouse.action === "wheel") {
                setFocus("conversation");
                setScrollOffset((value) => Math.max(0, value + (mouse.button === "wheel-up" ? 3 : -3)));
                return;
            }
            if (mouse.action === "press" && mouse.button === "right") {
                if (containsPoint(metrics(composerRef), mouse.x, mouse.y))
                    openReader("composer");
                else
                    openReader("conversation");
                return;
            }
            if (mouse.action !== "press" || mouse.button !== "left")
                return;
            if (containsPoint(metrics(commandButtonRef), mouse.x, mouse.y)) {
                setOverlay("commands");
                return;
            }
            if (containsPoint(metrics(filesButtonRef), mouse.x, mouse.y)) {
                setOverlay("context");
                return;
            }
            if (containsPoint(metrics(modelsButtonRef), mouse.x, mouse.y)) {
                setOverlay("models");
                return;
            }
            if (containsPoint(metrics(sessionsButtonRef), mouse.x, mouse.y)) {
                setOverlay("sessions");
                return;
            }
            if (containsPoint(metrics(helpButtonRef), mouse.x, mouse.y)) {
                setOverlay("help");
                return;
            }
            if (containsPoint(metrics(modeButtonRef), mouse.x, mouse.y)) {
                cyclePermissionMode();
                return;
            }
            if (containsPoint(metrics(readerButtonRef), mouse.x, mouse.y)) {
                openReader();
                return;
            }
            for (const [index, node] of activityItemRefs.current) {
                if (containsPoint(measureElement(node), mouse.x, mouse.y)) {
                    setSelectedActivity(index);
                    return;
                }
            }
            if (containsPoint(metrics(conversationPaneRef), mouse.x, mouse.y)) {
                setFocus("conversation");
                return;
            }
            if (containsPoint(metrics(composerRef), mouse.x, mouse.y)) {
                setFocus("composer");
                return;
            }
            return;
        }
        if (approval) {
            if (character.toLowerCase() === "y")
                closeApproval(true);
            else if (character.toLowerCase() === "n" || key.escape)
                closeApproval(false);
            else if (key.return)
                closeApproval(approvalChoice === "allow");
            else if (key.leftArrow || key.rightArrow || key.tab || key.upArrow || key.downArrow)
                setApprovalChoice((value) => (value === "allow" ? "deny" : "allow"));
            return;
        }
        if (key.ctrl && character === "c") {
            if (busy) {
                session.cancel();
                operationAbortRef.current?.abort();
            }
            else
                exit();
            return;
        }
        if (key.escape) {
            if (overlay)
                setOverlay(null);
            else if (busy) {
                session.cancel();
                operationAbortRef.current?.abort();
            }
            return;
        }
        if (key.ctrl && character === "k") {
            setOverlay("commands");
            return;
        }
        if (key.ctrl && character === "m") {
            setOverlay("models");
            return;
        }
        if (key.ctrl && character === "p") {
            setOverlay("context");
            return;
        }
        if (key.ctrl && character === "s") {
            setOverlay("sessions");
            return;
        }
        if (key.ctrl && character === "t") {
            config.ui.mouse = !config.ui.mouse;
            saveConfig(config);
            setNotice(config.ui.mouse ? "Mouse capture on — click controls; Shift+drag may select text in supported terminals." : "Mouse capture off — drag to select and copy text normally.");
            setRevision((value) => value + 1);
            return;
        }
        if (key.ctrl && character === "a") {
            cyclePermissionMode();
            return;
        }
        if (key.ctrl && character === "y") {
            openReader();
            return;
        }
        if (key.ctrl && character === "e") {
            openReader("context");
            return;
        }
        if (key.tab) {
            // One pane now, so Tab just swaps between typing and scrolling the
            // conversation with the arrow keys.
            setFocus((current) => (current === "composer" ? "conversation" : "composer"));
            return;
        }
        if (overlay) {
            if (key.upArrow)
                setSelected((value) => Math.max(0, value - 1));
            else if (key.downArrow)
                setSelected((value) => Math.max(0, Math.min(filteredOverlayItems.length - 1, value + 1)));
            else if (key.return)
                selectOverlayItem();
            else if (key.backspace || key.delete) {
                setOverlayQuery((value) => value.slice(0, -1));
                setSelected(0);
            }
            else if (!key.ctrl && !key.meta && character) {
                setOverlayQuery((value) => value + character);
                setSelected(0);
            }
            return;
        }
        if (character === "?" && !input) {
            setOverlay("help");
            return;
        }
        if (focus === "activity") {
            if (key.upArrow) {
                setSelectedActivity((value) => Math.max(0, value - 1));
                return;
            }
            if (key.downArrow) {
                setSelectedActivity((value) => Math.max(0, Math.min(activities.length - 1, value + 1)));
                return;
            }
            if (key.return) {
                const item = activities[selectedActivity];
                if (item)
                    setNotice(`${item.name}: ${item.result ? sanitizeTerminalText(item.result).slice(0, 300) : item.status}`);
                return;
            }
        }
        if (focus === "conversation" && (key.upArrow || key.downArrow)) {
            setScrollOffset((value) => Math.max(0, value + (key.upArrow ? 1 : -1)));
            return;
        }
        if (focus === "context" && key.return) {
            setOverlay("context");
            return;
        }
        if (key.pageUp) {
            setScrollOffset((value) => value + 5);
            return;
        }
        if (key.pageDown) {
            setScrollOffset((value) => Math.max(0, value - 5));
            return;
        }
        if (focus !== "composer" && key.return) {
            setFocus("composer");
            return;
        }
        if (focus !== "composer" && (key.leftArrow || key.rightArrow || key.backspace || key.delete))
            return;
        if (focus !== "composer" && !key.ctrl && !key.meta && character)
            setFocus("composer");
        if (key.ctrl && character === "j") {
            setInput((value) => value.slice(0, cursor) + "\n" + value.slice(cursor));
            setCursor((value) => value + 1);
            return;
        }
        if (key.return) {
            void submit();
            return;
        }
        if (key.leftArrow) {
            setCursor((value) => Math.max(0, value - 1));
            return;
        }
        if (key.rightArrow) {
            setCursor((value) => Math.min(input.length, value + 1));
            return;
        }
        if (key.backspace || key.delete) {
            if (cursor > 0) {
                setInput((value) => value.slice(0, cursor - 1) + value.slice(cursor));
                setCursor((value) => value - 1);
            }
            return;
        }
        if (!key.ctrl && !key.meta && character) {
            // Real pastes go through usePaste below (bracketed paste mode delivers
            // the whole blob atomically, however many raw chunks the terminal
            // split it into). This branch only still sees large text if the
            // terminal doesn't support bracketed paste at all — same collapse
            // logic as a fallback.
            if (character.length > PASTE_COLLAPSE_THRESHOLD) {
                insertPastedText(character);
                return;
            }
            setInput((value) => value.slice(0, cursor) + character + value.slice(cursor));
            setCursor((value) => value + character.length);
        }
    });
    usePaste((text) => { insertPastedText(text); });
    const profile = config.profiles[config.activeProfile];
    const allMessages = messagesRef.current.filter((message) => message.role === "user" || message.role === "assistant");
    const displayMessages = streamText ? [...allMessages, { role: "assistant", content: streamText }] : allMessages;
    const maxMessages = Math.max(2, Math.floor((dimensions.rows - 10) / 4));
    const messageMaxLines = Math.max(15, dimensions.rows - 10);
    const end = Math.max(0, displayMessages.length - scrollOffset);
    const visibleMessages = displayMessages.slice(Math.max(0, end - maxMessages), end);
    // Single full-width pane: only the root's paddingX(1 each side) is taken
    // out. Used to pre-wrap messages ourselves so the row cap is enforced on
    // rendered rows rather than raw "\n"-delimited lines (one very long line
    // with no newlines would otherwise ignore a line-count cap entirely).
    const conversationPaneWidth = Math.max(20, dimensions.columns - 2);
    const suggestions = tuiCommandSuggestions(input);
    const estimatedCostUsd = estimateCost(profile, usage, pricing);
    const contextTokens = estimateMessageTokens(messagesRef.current);
    const usageLine = renderUsageStatus(config, { ...usage, contextTokens, estimatedCostUsd, subscriptionTokensUsed }, dimensions.columns - 2);
    const limitExceeded = (profile.subscription?.tokenLimit != null && subscriptionTokensUsed >= profile.subscription.tokenLimit)
        || (profile.subscription?.costLimitUsd != null && estimatedCostUsd != null && estimatedCostUsd >= profile.subscription.costLimitUsd)
        || (profile.contextWindowTokens != null && contextTokens / profile.contextWindowTokens >= 0.9);
    const cursorView = `${input.slice(0, cursor)}█${input.slice(cursor)}`;
    // The composer must never grow past a few rows. It renders whatever is in
    // the buffer, so anything that floods stdin — a runaway paste, a stuck key,
    // a remote-desktop/terminal quirk replaying keystrokes — otherwise grows
    // this box until the whole frame is taller than the terminal. Once that
    // happens the terminal scrolls, Ink's cursor-relative redraw math is
    // permanently off by however much it scrolled, and every later frame paints
    // at the wrong offset: old and new frames end up superimposed, with text
    // running across pane borders. Bounding the rendered rows here (the full
    // text stays in state, only the view is windowed) keeps the frame height
    // fixed no matter what arrives on stdin.
    const composerWidth = Math.max(20, dimensions.columns - 4);
    const composerMaxRows = Math.max(1, Math.min(6, Math.floor(dimensions.rows / 5)));
    const composerText = busy
        ? `working… type to queue · esc cancels${input ? `\n❯ ${cursorView}` : ""}`
        : `❯ ${cursorView}${input ? "" : "  send a message, or / for a command"}`;
    const composerRows = wrapReaderText(sanitizeTerminalText(composerText), composerWidth);
    // Window the view onto the row holding the cursor so typing stays visible
    // even when the buffer is far longer than the box.
    const cursorRow = composerRows.findIndex((row) => row.includes("█"));
    const anchorRow = cursorRow >= 0 ? cursorRow : composerRows.length - 1;
    const composerStart = Math.max(0, Math.min(anchorRow - composerMaxRows + 1, composerRows.length - composerMaxRows));
    const visibleComposerRows = composerRows.slice(composerStart, composerStart + composerMaxRows);
    const hiddenComposerRows = composerRows.length - visibleComposerRows.length;
    const readerLines = reader ? wrapReaderText(reader.content, dimensions.columns) : [];
    const readerPageSize = Math.max(1, dimensions.rows - 3);
    void revision;
    if (reader) {
        const visibleReaderLines = readerLines.slice(readerOffset, readerOffset + readerPageSize);
        return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, overflow: "hidden", children: [_jsxs(Text, { bold: true, inverse: true, children: ["FORGE READER \u00B7 ", reader.title] }), _jsxs(Text, { color: theme.muted, children: ["Drag to select this pane only \u00B7 Ctrl+Y/Esc close \u00B7 \u2191/\u2193 or PgUp/PgDn scroll \u00B7 ", readerOffset + 1, "-", Math.min(readerLines.length, readerOffset + readerPageSize), "/", readerLines.length] }), _jsx(Text, { children: " " }), visibleReaderLines.map((line, index) => _jsx(Text, { wrap: "truncate-end", children: line || " " }, `${readerOffset}-${index}`))] });
    }
    // Each of these takes over the whole screen while active, then returns to
    // the chat view below once dismissed — see the Frame component for why.
    if (keyEntry)
        return _jsx(KeyEntryModal, { dimensions: dimensions, name: keyEntry.name, mode: keyEntry.mode, draft: keyEntry.draft, theme: theme });
    if (approval)
        return _jsx(ApprovalModal, { dimensions: dimensions, allowRef: approvalAllowRef, denyRef: approvalDenyRef, state: approval, choice: approvalChoice, theme: theme });
    if (overlay)
        return _jsx(Overlay, { dimensions: dimensions, itemRefs: overlayItemRefs, title: overlay.toUpperCase(), query: overlayQuery, items: filteredOverlayItems, selected: selected, theme: theme, footer: "Type/filter \u00B7 click or \u2191/\u2193 + Enter \u00B7 wheel scroll \u00B7 Esc close" });
    // overflow="hidden" on the root is the structural guarantee that makes the
    // whole "content taller than the screen wrecks everything" class of bug
    // impossible. height alone doesn't do it: Yoga still lets children overflow
    // a fixed-height box, Ink then emits more lines than the terminal has rows,
    // the terminal scrolls, and from that point Ink's cursor-relative redraw is
    // permanently off by however far it scrolled — every later frame paints at
    // the wrong offset and old frames stay on screen underneath. Clipping here
    // means no component can ever push the frame past the terminal height,
    // whatever it renders.
    return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, overflow: "hidden", paddingX: 1, children: [_jsxs(Box, { flexShrink: 0, children: [_jsxs(Box, { flexShrink: 0, children: [_jsx(Text, { bold: true, color: theme.accent, children: "\u25C6 forge" }), _jsxs(Text, { color: theme.muted, dimColor: true, children: [" \u00B7 ", sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))] })] }), _jsx(Box, { flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: "flex-end", children: _jsxs(Text, { wrap: "truncate-end", color: theme.muted, children: [" ", sanitizeTerminalText(config.activeProfile), "/", sanitizeTerminalText(profile.model), " \u00B7 ", profile.kind === "local" ? "local" : "cloud", config.routing.offline ? " · offline" : ""] }) })] }), _jsxs(Box, { ref: conversationPaneRef, flexGrow: 1, flexShrink: 1, flexBasis: 0, flexDirection: "column", justifyContent: "flex-end", overflow: "hidden", marginTop: 1, children: [visibleMessages.map((message, index) => _jsx(MessageBlock, { message: message, theme: theme, maxLines: messageMaxLines, paneWidth: conversationPaneWidth }, `${message.role}-${index}`)), !visibleMessages.length && _jsx(WelcomeScreen, { theme: theme, config: config, profile: profile, height: Math.max(0, dimensions.rows - 8), hasResumable: hasResumableSession })] }), activities.length > 0 && _jsx(Box, { flexShrink: 0, flexDirection: "column", overflow: "hidden", marginTop: 1, children: activities.slice(0, 3).map((item, index) => _jsxs(Box, { ref: (node) => { if (node)
                        activityItemRefs.current.set(index, node);
                    else
                        activityItemRefs.current.delete(index); }, children: [_jsxs(Text, { color: item.status === "failed" ? theme.danger : item.status === "completed" ? theme.success : theme.warning, children: [statusSymbol(item.status), " "] }), _jsxs(Text, { color: theme.muted, wrap: "truncate-end", children: [sanitizeTerminalText(item.name), item.durationMs != null ? ` · ${item.durationMs}ms` : ""] })] }, item.id)) }), _jsx(Box, { flexShrink: 0, marginTop: 1, children: _jsx(Text, { color: busy ? theme.warning : focus === "composer" ? theme.accent : theme.muted, dimColor: !busy && focus !== "composer", children: "─".repeat(Math.max(0, dimensions.columns - 2)) }) }), _jsxs(Box, { ref: composerRef, flexDirection: "column", flexShrink: 0, overflow: "hidden", children: [visibleComposerRows.map((row, index) => (_jsx(Text, { color: busy ? theme.warning : theme.text, wrap: "truncate-end", children: row || " " }, index))), hiddenComposerRows > 0 && _jsxs(Text, { color: theme.muted, wrap: "truncate-end", children: ["\u2026 ", hiddenComposerRows, " more line", hiddenComposerRows === 1 ? "" : "s"] })] }), _jsx(Box, { flexShrink: 0, children: _jsx(Text, { color: busy ? theme.warning : focus === "composer" ? theme.accent : theme.muted, dimColor: !busy && focus !== "composer", children: "─".repeat(Math.max(0, dimensions.columns - 2)) }) }), suggestions.length > 0 && _jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: theme.accent, dimColor: true, wrap: "truncate-end", children: suggestions.join("   ") }) }), queuedPrompt && _jsx(Box, { paddingLeft: 2, children: _jsxs(Text, { color: theme.warning, wrap: "truncate-end", children: ["queued \u00B7 ", sanitizeTerminalText(queuedPrompt)] }) }), _jsxs(Box, { flexShrink: 0, overflow: "hidden", marginTop: 1, children: [_jsxs(Box, { flexShrink: 0, children: [_jsx(Text, { color: busy ? theme.warning : theme.success, children: busy ? "●" : "○" }), _jsxs(Text, { color: theme.muted, children: [" ", busy ? "working" : "ready"] })] }), _jsx(Box, { flexGrow: 1, flexShrink: 1, minWidth: 0, children: _jsx(Text, { color: notice.startsWith("Error:") ? theme.danger : theme.muted, wrap: "truncate-end", children: notice === "Ready" ? "" : ` · ${sanitizeTerminalText(notice)}` }) }), _jsx(Box, { flexShrink: 0, children: _jsx(Text, { color: limitExceeded ? theme.danger : theme.muted, bold: limitExceeded, dimColor: !limitExceeded, wrap: "truncate-end", children: sanitizeTerminalText(usageLine) }) })] }), _jsxs(Box, { flexShrink: 0, gap: 3, overflow: "hidden", children: [_jsx(Box, { ref: commandButtonRef, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: "^K cmds" }) }), _jsx(Box, { ref: filesButtonRef, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: "^P files" }) }), _jsx(Box, { ref: modelsButtonRef, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: "^M models" }) }), _jsx(Box, { ref: sessionsButtonRef, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: "^S sessions" }) }), _jsx(Box, { ref: readerButtonRef, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: "^Y reader" }) }), _jsx(Box, { ref: modeButtonRef, flexShrink: 0, children: _jsxs(Text, { color: config.permissions.mode === "autonomous" ? theme.warning : theme.muted, dimColor: config.permissions.mode !== "autonomous", children: ["^A ", config.permissions.mode] }) }), _jsx(Box, { ref: helpButtonRef, flexShrink: 0, children: _jsx(Text, { color: theme.muted, dimColor: true, children: "? help" }) })] })] });
}
