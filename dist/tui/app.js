import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import path from "node:path";
import fs from "node:fs";
import fg from "fast-glob";
import { Box, Text, measureElement, useApp, useInput, useStdout } from "ink";
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
import { containsPoint, DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, parseMouseInput } from "./mouse.js";
import { formatReaderStatus, wrapReaderText } from "./reader.js";
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
/**
 * Full-screen frame shell shared by every modal-like view (overlay lists,
 * approval, key entry, the reader). Replacing the chat view outright — rather
 * than layering a partially-transparent box on top of it — is deliberate:
 * Ink has no real background fill, so a floating box over live content lets
 * conversation text bleed through the gaps and around the edges, which reads
 * as visual noise stacked on top of the modal's own text.
 */
function Frame({ dimensions, title, titleColor, footer, children }) {
    return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, paddingX: 2, paddingY: 1, children: [_jsxs(Text, { bold: true, inverse: true, color: titleColor, children: [" ", title, " "] }), _jsx(Text, { children: " " }), _jsx(Box, { flexDirection: "column", flexGrow: 1, children: children }), footer && _jsx(Text, { color: "gray", children: footer })] });
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
function ApprovalModal({ dimensions, state, theme, allowRef, denyRef }) {
    const args = summarizeToolArguments(state.request.activity.args);
    return _jsxs(Frame, { dimensions: dimensions, title: `APPROVAL REQUIRED · ${state.request.activity.risk.toUpperCase()}`, titleColor: theme.warning, footer: "Y/N/Esc \u00B7 Enter denies safely", children: [_jsx(Text, { bold: true, children: state.request.activity.name }), _jsx(Text, { color: theme.muted, wrap: "wrap", children: args }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Box, { ref: allowRef, children: _jsx(Text, { color: theme.success, children: "[ Allow once ]" }) }), _jsx(Box, { ref: denyRef, children: _jsx(Text, { color: theme.danger, children: "[ Deny ]" }) })] })] });
}
function KeyEntryModal({ dimensions, name, mode, draft, theme }) {
    return _jsxs(Frame, { dimensions: dimensions, title: mode === "add" ? `NEW PROVIDER · ${name}` : `UPDATE KEY · ${name}`, titleColor: theme.accent, footer: "Enter to save \u00B7 Esc to cancel", children: [_jsx(Text, { color: theme.muted, wrap: "wrap", children: "Paste or type the API key. It is masked here and never added to composer history." }), _jsx(Text, { children: " " }), _jsxs(Text, { color: theme.text, children: ["•".repeat(draft.length), "\u2588"] })] });
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
    const contextFilesRef = React.useRef(new Map());
    const approvalRef = React.useRef(null);
    const queuedPromptRef = React.useRef("");
    const operationAbortRef = React.useRef(null);
    const messagesRef = React.useRef(systemMessages(config));
    const sessionRef = React.useRef(null);
    const activityPaneRef = React.useRef(null);
    const conversationPaneRef = React.useRef(null);
    const contextPaneRef = React.useRef(null);
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
    const mouseButtonRef = React.useRef(null);
    const readerButtonRef = React.useRef(null);
    const statusButtonRef = React.useRef(null);
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
                setNotice(`Loaded ${item.id}`);
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
                        const allowed = await requestApproval({
                            call: { id, name: tool.def.name, arguments: JSON.stringify(requested.args) },
                            activity: { id, name: tool.def.name, risk: tool.risk, status: "waiting", args: requested.args, startedAt: Date.now() },
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
                if (containsPoint(metrics(activityPaneRef), mouse.x, mouse.y)) {
                    setFocus("activity");
                    setSelectedActivity((value) => Math.max(0, Math.min(activities.length - 1, value + (mouse.button === "wheel-down" ? 1 : -1))));
                }
                else {
                    setFocus("conversation");
                    setScrollOffset((value) => Math.max(0, value + (mouse.button === "wheel-up" ? 3 : -3)));
                }
                return;
            }
            if (mouse.action === "press" && mouse.button === "right") {
                if (containsPoint(metrics(activityPaneRef), mouse.x, mouse.y))
                    openReader("activity");
                else if (containsPoint(metrics(contextPaneRef), mouse.x, mouse.y))
                    openReader("context");
                else if (containsPoint(metrics(conversationPaneRef), mouse.x, mouse.y))
                    openReader("conversation");
                else if (containsPoint(metrics(composerRef), mouse.x, mouse.y))
                    openReader("composer");
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
            if (containsPoint(metrics(mouseButtonRef), mouse.x, mouse.y)) {
                config.ui.mouse = false;
                saveConfig(config);
                setNotice("Mouse capture off — drag to select text; Ctrl+T turns it back on.");
                setRevision((value) => value + 1);
                return;
            }
            if (containsPoint(metrics(readerButtonRef), mouse.x, mouse.y)) {
                openReader();
                return;
            }
            if (containsPoint(metrics(statusButtonRef), mouse.x, mouse.y)) {
                openReader("context");
                return;
            }
            for (const [index, node] of activityItemRefs.current) {
                if (containsPoint(measureElement(node), mouse.x, mouse.y)) {
                    setFocus("activity");
                    setSelectedActivity(index);
                    return;
                }
            }
            if (containsPoint(metrics(activityPaneRef), mouse.x, mouse.y)) {
                setFocus("activity");
                return;
            }
            if (containsPoint(metrics(contextPaneRef), mouse.x, mouse.y)) {
                setFocus("context");
                setOverlay("context");
                return;
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
        if (key.ctrl && character === "t") {
            config.ui.mouse = !config.ui.mouse;
            saveConfig(config);
            setNotice(config.ui.mouse ? "Mouse capture on — click controls; Shift+drag may select text in supported terminals." : "Mouse capture off — drag to select and copy text normally.");
            setRevision((value) => value + 1);
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
            const order = wide ? ["activity", "conversation", "context", "composer"] : medium ? ["conversation", "context", "composer"] : ["conversation", "composer"];
            setFocus((current) => order[(order.indexOf(current) + 1) % order.length]);
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
    const readerLines = reader ? wrapReaderText(reader.content, dimensions.columns) : [];
    const readerPageSize = Math.max(1, dimensions.rows - 3);
    void revision;
    if (reader) {
        const visibleReaderLines = readerLines.slice(readerOffset, readerOffset + readerPageSize);
        return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, children: [_jsxs(Text, { bold: true, inverse: true, children: ["FORGE READER \u00B7 ", reader.title] }), _jsxs(Text, { color: theme.muted, children: ["Drag to select this pane only \u00B7 Ctrl+Y/Esc close \u00B7 \u2191/\u2193 or PgUp/PgDn scroll \u00B7 ", readerOffset + 1, "-", Math.min(readerLines.length, readerOffset + readerPageSize), "/", readerLines.length] }), _jsx(Text, { children: " " }), visibleReaderLines.map((line, index) => _jsx(Text, { wrap: "truncate-end", children: line || " " }, `${readerOffset}-${index}`))] });
    }
    // Each of these takes over the whole screen while active, then returns to
    // the chat view below once dismissed — see the Frame component for why.
    if (keyEntry)
        return _jsx(KeyEntryModal, { dimensions: dimensions, name: keyEntry.name, mode: keyEntry.mode, draft: keyEntry.draft, theme: theme });
    if (approval)
        return _jsx(ApprovalModal, { dimensions: dimensions, allowRef: approvalAllowRef, denyRef: approvalDenyRef, state: approval, theme: theme });
    if (overlay)
        return _jsx(Overlay, { dimensions: dimensions, itemRefs: overlayItemRefs, title: overlay.toUpperCase(), query: overlayQuery, items: filteredOverlayItems, selected: selected, theme: theme, footer: "Type/filter \u00B7 click or \u2191/\u2193 + Enter \u00B7 wheel scroll \u00B7 Esc close" });
    return _jsxs(Box, { flexDirection: "column", height: dimensions.rows, width: dimensions.columns, children: [_jsxs(Box, { borderStyle: "round", borderColor: theme.focusBorder, paddingX: 1, justifyContent: "space-between", children: [_jsx(Text, { bold: true, color: theme.accent, children: "\u25C6 FORGE" }), _jsxs(Text, { wrap: "truncate-end", children: [sanitizeTerminalText(path.basename(config.permissions.workspaceRoot)), " \u00B7 ", sanitizeTerminalText(config.activeProfile), "/", sanitizeTerminalText(profile.model), " \u00B7 ", profile.kind === "local" ? "● local" : "◉ cloud", " \u00B7 ", config.permissions.mode, config.routing.offline ? " · offline" : ""] })] }), _jsxs(Box, { flexGrow: 1, children: [wide && _jsxs(Box, { ref: activityPaneRef, width: 25, flexDirection: "column", borderStyle: "single", borderColor: focus === "activity" ? theme.focusBorder : theme.border, paddingX: 1, children: [_jsx(Text, { bold: true, color: theme.accent, children: "ACTIVITY" }), activities.slice(0, Math.max(3, dimensions.rows - 10)).map((item, index) => _jsx(Box, { ref: (node) => { if (node)
                                    activityItemRefs.current.set(index, node);
                                else
                                    activityItemRefs.current.delete(index); }, children: _jsxs(Text, { inverse: focus === "activity" && index === selectedActivity, color: item.status === "failed" ? theme.danger : item.status === "completed" ? theme.success : theme.warning, wrap: "truncate-end", children: [statusSymbol(item.status), " ", sanitizeTerminalText(item.name), " ", item.durationMs != null ? `${item.durationMs}ms` : ""] }) }, item.id)), !activities.length && _jsx(Text, { color: theme.muted, children: "Tool calls appear here." })] }), _jsxs(Box, { ref: conversationPaneRef, flexGrow: 1, flexDirection: "column", borderStyle: "single", borderColor: focus === "conversation" ? theme.focusBorder : theme.border, paddingX: 1, children: [visibleMessages.map((message, index) => _jsx(MessageBlock, { message: message, theme: theme }, `${message.role}-${index}-${message.content.length}`)), !visibleMessages.length && _jsx(Box, { flexGrow: 1, alignItems: "center", justifyContent: "center", children: _jsx(Text, { color: theme.muted, children: "Ask about this workspace, press Ctrl+K for commands, or Ctrl+M for models." }) })] }), medium && _jsxs(Box, { ref: contextPaneRef, width: wide ? 29 : 25, flexDirection: "column", borderStyle: "single", borderColor: focus === "context" ? theme.focusBorder : theme.border, paddingX: 1, children: [_jsx(Text, { bold: true, color: theme.accent, children: "CONTEXT" }), _jsxs(Text, { wrap: "truncate-end", children: ["Workspace: ", sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))] }), _jsxs(Text, { children: ["Instructions: ", loadProjectInstructions(config.permissions.workspaceRoot).length] }), _jsxs(Text, { children: ["Pinned files: ", contextFilesRef.current.size] }), _jsxs(Text, { children: ["Messages: ", allMessages.length] }), _jsxs(Text, { children: ["Context: ~", estimateMessageTokens(messagesRef.current).toLocaleString("en-US"), " tokens"] }), _jsx(Text, { color: theme.muted, children: "Ctrl+P add files" }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { bold: true, color: theme.accent, children: "SESSION" }), _jsx(Text, { children: busy ? "● Working" : "○ Ready" }), _jsx(Text, { wrap: "wrap", color: theme.muted, children: sanitizeTerminalText(notice) })] })] })] }), _jsx(Box, { ref: composerRef, borderStyle: "round", borderColor: busy ? theme.warning : focus === "composer" ? theme.focusBorder : theme.border, paddingX: 1, minHeight: 3, children: _jsx(Text, { color: busy ? theme.warning : theme.text, wrap: "wrap", children: sanitizeTerminalText(busy ? `Working… type to queue · Esc cancel${input ? `\n› ${cursorView}` : ""}` : `› ${cursorView}`) }) }), suggestions.length > 0 && !overlay && _jsxs(Text, { color: theme.muted, children: [" ", suggestions.join("  ")] }), _jsx(Box, { paddingX: 1, justifyContent: "space-between", children: _jsx(Text, { color: limitExceeded ? theme.danger : theme.muted, bold: limitExceeded, wrap: "truncate-end", children: sanitizeTerminalText(usageLine) }) }), queuedPrompt && _jsxs(Text, { color: theme.warning, wrap: "truncate-end", children: [" Queued: ", sanitizeTerminalText(queuedPrompt)] }), _jsxs(Box, { paddingX: 1, gap: 1, children: [_jsx(Box, { ref: commandButtonRef, children: _jsx(Text, { color: theme.muted, children: "[Cmd ^K]" }) }), _jsx(Box, { ref: filesButtonRef, children: _jsx(Text, { color: theme.muted, children: "[Files ^P]" }) }), _jsx(Box, { ref: modelsButtonRef, children: _jsx(Text, { color: theme.muted, children: "[Models ^M]" }) }), _jsx(Box, { ref: sessionsButtonRef, children: _jsx(Text, { color: theme.muted, children: "[Sessions ^S]" }) }), _jsx(Box, { ref: helpButtonRef, children: _jsx(Text, { color: theme.muted, children: "[Help ?]" }) }), _jsx(Box, { ref: readerButtonRef, children: _jsx(Text, { color: theme.muted, children: "[Reader ^Y]" }) }), _jsx(Box, { ref: statusButtonRef, children: _jsx(Text, { color: notice.startsWith("Error:") ? theme.danger : theme.muted, children: "[Status ^E]" }) }), _jsx(Box, { ref: mouseButtonRef, children: _jsxs(Text, { color: config.ui.mouse ? theme.warning : theme.muted, children: ["[Mouse ", config.ui.mouse ? "on" : "off", " ^T]"] }) }), _jsx(Text, { color: theme.muted, children: " Tab panes" })] })] });
}
