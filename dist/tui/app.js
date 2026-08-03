import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import path from "node:path";
import fs from "node:fs";
import fg from "fast-glob";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { saveConfig } from "../config.js";
import { AgentSession } from "../agent/session.js";
import { createTools } from "../tools/index.js";
import { decidePermission } from "../security/policy.js";
import { fetchModels } from "../providers/models.js";
import { inspectLocalModel, listRuntimeSummaries, pullLocalModel } from "../runtime/service.js";
import { startRuntime, stopOwnedRuntime } from "../runtime/process.js";
import { listSessions, loadSession, saveSession } from "../session.js";
import { loadProjectInstructions } from "../project.js";
import { resolveWorkspacePath } from "../security/workspace.js";
import { estimateCost, estimateMessageTokens, renderUsageStatus } from "../usage.js";
import { loadUsageLedger } from "../usage-store.js";
import { SLASH_COMMANDS } from "../commands/registry.js";
import { executeTuiCommand, tuiCommandSuggestions } from "./commands.js";
import { sanitizeTerminalText, summarizeToolArguments } from "./sanitize.js";
import { getTheme } from "./theme.js";
function systemMessages(config) {
    const instructions = loadProjectInstructions(config.permissions.workspaceRoot)
        .map((item) => `\n\n[${item.file}]\n${item.content}`).join("");
    return [{ role: "system", content: `You are Forge, a concise AI coding assistant. Work only inside the approved workspace. Use tools when useful.${instructions}` }];
}
function statusSymbol(status) {
    return status === "completed" ? "✓" : status === "failed" ? "×" : status === "denied" ? "!" : status === "running" ? "●" : "○";
}
function MessageBlock({ message, theme }) {
    const sanitized = sanitizeTerminalText(message.content);
    const safe = sanitized.length > 12_000 ? `…[earlier content clipped]\n${sanitized.slice(-12_000)}` : sanitized;
    const role = message.role === "user" ? "YOU" : "FORGE";
    const color = message.role === "user" ? theme.accent : theme.success;
    return _jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsx(Text, { bold: true, color: color, children: role }), safe.split("\n").map((line, index) => {
                const code = /^\s{4}|^```/.test(line);
                const heading = /^#{1,6}\s/.test(line);
                return _jsx(Text, { color: code ? theme.code : theme.text, bold: heading, wrap: "wrap", children: line || " " }, index);
            })] });
}
function Overlay({ title, query, items, selected, theme, footer }) {
    return _jsxs(Box, { position: "absolute", width: "82%", minHeight: 8, alignSelf: "center", marginTop: 2, flexDirection: "column", borderStyle: "double", borderColor: theme.focusBorder, paddingX: 2, paddingY: 1, children: [_jsx(Text, { bold: true, color: theme.accent, children: title }), _jsxs(Text, { color: theme.text, children: ["Search: ", sanitizeTerminalText(query), "\u2588"] }), _jsx(Text, { color: theme.muted, children: "─".repeat(54) }), items.slice(Math.max(0, selected - 6), Math.max(0, selected - 6) + 13).map((item, index) => {
                const absolute = Math.max(0, selected - 6) + index;
                return _jsxs(Text, { color: absolute === selected ? theme.accent : theme.text, inverse: absolute === selected, children: [absolute === selected ? " › " : "   ", sanitizeTerminalText(item.label), item.detail ? `  ${sanitizeTerminalText(item.detail)}` : ""] }, item.id);
            }), !items.length && _jsx(Text, { color: theme.muted, children: "No items available." }), _jsx(Text, { color: theme.muted, children: footer })] });
}
function ApprovalModal({ state, theme }) {
    const args = summarizeToolArguments(state.request.activity.args);
    return _jsxs(Box, { position: "absolute", width: "86%", alignSelf: "center", marginTop: 2, flexDirection: "column", borderStyle: "double", borderColor: theme.warning, paddingX: 2, paddingY: 1, children: [_jsxs(Text, { bold: true, color: theme.warning, children: ["APPROVAL REQUIRED \u00B7 ", state.request.activity.risk.toUpperCase()] }), _jsx(Text, { bold: true, children: state.request.activity.name }), _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: args }), _jsx(Text, { color: theme.warning, children: "Y allow once \u00B7 N/Esc deny \u00B7 Enter denies safely" })] });
}
/** Render Forge's responsive, keyboard-first full-screen terminal workspace. */
export function ForgeTui({ config }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [dimensions, setDimensions] = React.useState({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 30 });
    const [input, setInput] = React.useState("");
    const [cursor, setCursor] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const [streamText, setStreamText] = React.useState("");
    const [revision, setRevision] = React.useState(0);
    const [notice, setNotice] = React.useState("Ready");
    const [activities, setActivities] = React.useState([]);
    const [approval, setApproval] = React.useState(null);
    const [overlay, setOverlay] = React.useState(null);
    const [overlayQuery, setOverlayQuery] = React.useState("");
    const [overlayItems, setOverlayItems] = React.useState([]);
    const [selected, setSelected] = React.useState(0);
    const [scrollOffset, setScrollOffset] = React.useState(0);
    const [queuedPrompt, setQueuedPrompt] = React.useState("");
    const [usage, setUsage] = React.useState({ promptTokens: 0, completionTokens: 0 });
    const [subscriptionTokensUsed, setSubscriptionTokensUsed] = React.useState(() => {
        const entry = loadUsageLedger().profiles[config.activeProfile];
        return entry ? entry.promptTokens + entry.completionTokens : 0;
    });
    const [pricing, setPricing] = React.useState();
    const contextFilesRef = React.useRef(new Map());
    const approvalRef = React.useRef(null);
    const queuedPromptRef = React.useRef("");
    const operationAbortRef = React.useRef(null);
    const messagesRef = React.useRef(systemMessages(config));
    const sessionRef = React.useRef(null);
    const theme = getTheme(config.ui.theme);
    const requestApproval = React.useCallback((request) => new Promise((resolve) => {
        const value = { request, resolve };
        approvalRef.current = value;
        setApproval(value);
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
        const resize = () => setDimensions({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 30 });
        stdout.on("resize", resize);
        return () => { stdout.off("resize", resize); };
    }, [stdout]);
    React.useEffect(() => session.subscribe((event) => {
        if (event.type === "turn.started") {
            setBusy(true);
            setStreamText("");
            setNotice("Thinking…");
            setRevision((value) => value + 1);
        }
        else if (event.type === "text.delta")
            setStreamText((value) => value + event.delta);
        else if (event.type === "message.completed") {
            setStreamText("");
            saveSession("autosave", messagesRef.current);
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
            setBusy(false);
            setNotice(`Error: ${sanitizeTerminalText(event.error.message)}`);
        }
        else if (event.type === "turn.cancelled") {
            setBusy(false);
            setNotice("Cancelled");
        }
        else if (event.type === "turn.completed") {
            setBusy(false);
            setNotice("Ready");
            setRevision((value) => value + 1);
            flushQueuedPrompt();
        }
    }), [flushQueuedPrompt, session]);
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
            setOverlayItems(listSessions().map((name) => ({ id: name, label: name })));
        }
    }, [overlay, config]);
    const filteredOverlayItems = React.useMemo(() => {
        const query = overlayQuery.trim().toLowerCase();
        if (!query)
            return overlayItems;
        return overlayItems.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query));
    }, [overlayItems, overlayQuery]);
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
    const selectOverlayItem = React.useCallback(() => {
        const item = filteredOverlayItems[selected];
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
                setNotice(`Loaded ${item.id}`);
                setOverlay(null);
                setRevision((value) => value + 1);
            }
            catch {
                setNotice(`Could not load ${item.id}`);
            }
        }
    }, [config, filteredOverlayItems, overlay, selected]);
    const submit = React.useCallback(async () => {
        const value = input.trim();
        if (!value)
            return;
        setInput("");
        setCursor(0);
        setScrollOffset(0);
        if (busy) {
            queuedPromptRef.current = value;
            setQueuedPrompt(value);
            setNotice("Prompt queued for the next turn");
            return;
        }
        const command = executeTuiCommand(value, {
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
            setNotice(`Loaded ${command.name}`);
            setRevision((revision) => revision + 1);
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
        if (command.type === "tool") {
            const tool = createTools({ workspaceRoot: config.permissions.workspaceRoot }).find((item) => item.def.name === command.name);
            if (!tool) {
                setNotice(`Tool ${command.name} is unavailable.`);
                return;
            }
            const decision = decidePermission(config.permissions.mode, tool.risk);
            if (decision === "deny") {
                setNotice(`${config.permissions.mode} mode blocks ${tool.risk} tools.`);
                return;
            }
            if (decision === "ask") {
                const id = `command-${Date.now()}`;
                const allowed = await requestApproval({
                    call: { id, name: tool.def.name, arguments: JSON.stringify(command.args) },
                    activity: { id, name: tool.def.name, risk: tool.risk, status: "waiting", args: command.args, startedAt: Date.now() },
                });
                if (!allowed) {
                    setNotice("Command denied.");
                    return;
                }
            }
            const activity = { id: `command-${Date.now()}`, name: tool.def.name, risk: tool.risk, status: "running", args: command.args, startedAt: Date.now() };
            setActivities((items) => [activity, ...items].slice(0, 20));
            setBusy(true);
            operationAbortRef.current = new AbortController();
            try {
                const result = await tool.execute(command.args, operationAbortRef.current.signal);
                activity.status = "completed";
                activity.result = result;
                activity.durationMs = Date.now() - activity.startedAt;
                messagesRef.current.push({ role: "assistant", content: `Command output (${tool.def.name}):\n${result}` });
                setNotice(`${tool.def.name} completed.`);
            }
            catch (error) {
                activity.status = "failed";
                activity.result = error instanceof Error ? error.message : String(error);
                activity.durationMs = Date.now() - activity.startedAt;
                setNotice(`${tool.def.name} failed: ${activity.result}`);
            }
            finally {
                setActivities((items) => [{ ...activity }, ...items.filter((item) => item.id !== activity.id)].slice(0, 20));
                operationAbortRef.current = null;
                setBusy(false);
                setRevision((revision) => revision + 1);
                flushQueuedPrompt();
            }
            return;
        }
        await session.send(command.type === "prompt" ? command.prompt : value);
    }, [busy, config, exit, flushQueuedPrompt, input, requestApproval, session]);
    useInput((character, key) => {
        if (approval) {
            if (character.toLowerCase() === "y")
                closeApproval(true);
            else if (character.toLowerCase() === "n" || key.escape || key.return)
                closeApproval(false);
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
        if (key.pageUp) {
            setScrollOffset((value) => value + 5);
            return;
        }
        if (key.pageDown) {
            setScrollOffset((value) => Math.max(0, value - 5));
            return;
        }
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
            setInput((value) => value.slice(0, cursor) + character + value.slice(cursor));
            setCursor((value) => value + character.length);
        }
    });
    const profile = config.profiles[config.activeProfile];
    const allMessages = messagesRef.current.filter((message) => message.role === "user" || message.role === "assistant");
    const displayMessages = streamText ? [...allMessages, { role: "assistant", content: streamText }] : allMessages;
    const maxMessages = Math.max(2, Math.floor((dimensions.rows - 10) / 4));
    const end = Math.max(0, displayMessages.length - scrollOffset);
    const visibleMessages = displayMessages.slice(Math.max(0, end - maxMessages), end);
    const wide = dimensions.columns >= 120;
    const medium = dimensions.columns >= 90;
    const suggestions = tuiCommandSuggestions(input);
    const estimatedCostUsd = estimateCost(profile, usage, pricing);
    const usageLine = renderUsageStatus(config, { ...usage, contextTokens: estimateMessageTokens(messagesRef.current), estimatedCostUsd, subscriptionTokensUsed }, dimensions.columns - 2);
    const limitExceeded = (profile.subscription?.tokenLimit != null && subscriptionTokensUsed >= profile.subscription.tokenLimit)
        || (profile.subscription?.costLimitUsd != null && estimatedCostUsd != null && estimatedCostUsd >= profile.subscription.costLimitUsd);
    const cursorView = `${input.slice(0, cursor)}█${input.slice(cursor)}`;
    void revision;
    return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, children: [_jsxs(Box, { borderStyle: "round", borderColor: theme.focusBorder, paddingX: 1, justifyContent: "space-between", children: [_jsx(Text, { bold: true, color: theme.accent, children: "\u25C6 FORGE" }), _jsxs(Text, { wrap: "truncate-end", children: [sanitizeTerminalText(path.basename(config.permissions.workspaceRoot)), " \u00B7 ", sanitizeTerminalText(config.activeProfile), "/", sanitizeTerminalText(profile.model), " \u00B7 ", profile.kind === "local" ? "● local" : "◉ cloud", " \u00B7 ", config.permissions.mode, config.routing.offline ? " · offline" : ""] })] }), _jsxs(Box, { flexGrow: 1, children: [wide && _jsxs(Box, { width: 25, flexDirection: "column", borderStyle: "single", borderColor: theme.border, paddingX: 1, children: [_jsx(Text, { bold: true, color: theme.accent, children: "ACTIVITY" }), activities.slice(0, Math.max(3, dimensions.rows - 10)).map((item) => _jsxs(Text, { color: item.status === "failed" ? theme.danger : item.status === "completed" ? theme.success : theme.warning, wrap: "truncate-end", children: [statusSymbol(item.status), " ", sanitizeTerminalText(item.name), " ", item.durationMs != null ? `${item.durationMs}ms` : ""] }, item.id)), !activities.length && _jsx(Text, { color: theme.muted, children: "Tool calls appear here." })] }), _jsxs(Box, { flexGrow: 1, flexDirection: "column", borderStyle: "single", borderColor: theme.focusBorder, paddingX: 1, children: [visibleMessages.map((message, index) => _jsx(MessageBlock, { message: message, theme: theme }, `${message.role}-${index}-${message.content.length}`)), !visibleMessages.length && _jsx(Box, { flexGrow: 1, alignItems: "center", justifyContent: "center", children: _jsx(Text, { color: theme.muted, children: "Ask about this workspace, press Ctrl+K for commands, or Ctrl+M for models." }) })] }), medium && _jsxs(Box, { width: wide ? 29 : 25, flexDirection: "column", borderStyle: "single", borderColor: theme.border, paddingX: 1, children: [_jsx(Text, { bold: true, color: theme.accent, children: "CONTEXT" }), _jsxs(Text, { wrap: "truncate-end", children: ["Workspace: ", sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))] }), _jsxs(Text, { children: ["Instructions: ", loadProjectInstructions(config.permissions.workspaceRoot).length] }), _jsxs(Text, { children: ["Pinned files: ", contextFilesRef.current.size] }), _jsxs(Text, { children: ["Messages: ", allMessages.length] }), _jsxs(Text, { children: ["Context: ~", estimateMessageTokens(messagesRef.current).toLocaleString("en-US"), " tokens"] }), _jsx(Text, { color: theme.muted, children: "Ctrl+P add files" }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { bold: true, color: theme.accent, children: "SESSION" }), _jsx(Text, { children: busy ? "● Working" : "○ Ready" }), _jsx(Text, { wrap: "wrap", color: theme.muted, children: sanitizeTerminalText(notice) })] })] })] }), _jsx(Box, { borderStyle: "round", borderColor: busy ? theme.warning : theme.focusBorder, paddingX: 1, minHeight: 3, children: _jsx(Text, { color: busy ? theme.warning : theme.text, wrap: "wrap", children: sanitizeTerminalText(busy ? `Working… type to queue · Esc cancel${input ? `\n› ${cursorView}` : ""}` : `› ${cursorView}`) }) }), suggestions.length > 0 && !overlay && _jsxs(Text, { color: theme.muted, children: [" ", suggestions.join("  ")] }), _jsx(Box, { paddingX: 1, justifyContent: "space-between", children: _jsx(Text, { color: limitExceeded ? theme.danger : theme.muted, bold: limitExceeded, wrap: "truncate-end", children: sanitizeTerminalText(usageLine) }) }), queuedPrompt && _jsxs(Text, { color: theme.warning, wrap: "truncate-end", children: [" Queued: ", sanitizeTerminalText(queuedPrompt)] }), _jsx(Text, { color: theme.muted, children: " Ctrl+K commands \u00B7 Ctrl+P files \u00B7 Ctrl+M models \u00B7 Ctrl+S sessions \u00B7 PgUp/PgDn scroll \u00B7 Ctrl+J newline \u00B7 ? help" }), overlay && _jsx(Overlay, { title: overlay.toUpperCase(), query: overlayQuery, items: filteredOverlayItems, selected: selected, theme: theme, footer: "Type to filter \u00B7 \u2191/\u2193 select \u00B7 Enter choose \u00B7 Esc close" }), approval && _jsx(ApprovalModal, { state: approval, theme: theme })] });
}
