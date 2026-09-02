import React from "react";
import path from "node:path";
import fs from "node:fs";
import fg from "fast-glob";
import { Box, Text, measureElement, useApp, useInput, usePaste, useStdout, type DOMElement } from "ink";
import type { ForgeConfig, PermissionMode, Profile } from "../config.js";
import { saveConfig } from "../config.js";
import type { ChatMessage } from "../providers/types.js";
import { AgentSession, type ApprovalRequest } from "../agent/session.js";
import type { AgentEvent, AgentUsage, ToolActivity } from "../agent/events.js";
import { createTools } from "../tools/index.js";
import { decidePermission } from "../security/policy.js";
import { fetchModels, type ModelInfo } from "../providers/models.js";
import { createDriver } from "../providers/index.js";
import { applyUndo, popUndo } from "../undo.js";
import { inspectLocalModel, listRuntimeSummaries, pullLocalModel } from "../runtime/service.js";
import { startRuntime, stopOwnedRuntime } from "../runtime/process.js";
import { listSessions, loadSession, saveSession } from "../session.js";
import { loadProjectInstructions } from "../project.js";
import { resolveWorkspacePath } from "../security/workspace.js";
import { estimateCost, estimateMessageTokens, renderUsageStatus } from "../usage.js";
import { loadUsageLedger } from "../usage-store.js";
import { SLASH_COMMANDS } from "../commands/registry.js";
import { executeTuiCommand, tuiCommandSuggestions, type TuiOverlay } from "./commands.js";
import { sanitizeTerminalText, summarizeToolArguments } from "./sanitize.js";
import { getTheme } from "./theme.js";
import { containsPoint, DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, parseMouseInput } from "./mouse.js";
import { formatReaderStatus, wrapReaderText } from "./reader.js";

interface SelectItem { id: string; label: string; detail?: string }
interface ApprovalState { request: ApprovalRequest; resolve: (allowed: boolean) => void }
type TuiFocus = "activity" | "conversation" | "context" | "composer";
interface ReaderState { title: string; content: string }

// A paste this size or larger would make Ink re-wrap and redraw a multi-thousand-
// character single line on every keystroke, which is slow enough to visibly
// corrupt the terminal frame. Collapse it to a placeholder instead.
const PASTE_COLLAPSE_THRESHOLD = 400;
const MAX_PASTE_CHARS = 2_000_000;

export function pastePlaceholder(id: number, content: string): string {
  const lines = content.split("\n").length;
  return `[Pasted ${content.length.toLocaleString("en-US")} chars, ${lines} line${lines === 1 ? "" : "s"} #${id}]`;
}

/** Replace every known paste placeholder in `value` with its stored full content. */
export function expandPastedBlocks(value: string, blocks: Map<string, string>): string {
  let result = value;
  for (const [token, content] of blocks) result = result.split(token).join(content);
  return result;
}

function systemMessages(config: ForgeConfig): ChatMessage[] {
  const instructions = loadProjectInstructions(config.permissions.workspaceRoot)
    .map((item) => `\n\n[${item.file}]\n${item.content}`).join("");
  return [{ role: "system", content: `You are Forge, a concise AI coding assistant. Work only inside the approved workspace. Use tools when useful.${instructions}` }];
}

function statusSymbol(status: ToolActivity["status"]): string {
  return status === "completed" ? "✓" : status === "failed" ? "×" : status === "denied" ? "!" : status === "running" ? "●" : "○";
}

export function MessageBlock({ message, theme, maxLines, paneWidth }: { message: ChatMessage; theme: ReturnType<typeof getTheme>; maxLines: number; paneWidth: number }): React.ReactElement {
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
    const allRows = wrapReaderText(wrapBudget, paneWidth);
    const overflow = budgetTruncated ? Math.max(1, allRows.length - maxLines) : allRows.length - maxLines;
    return { rows: overflow > 0 ? allRows.slice(0, maxLines) : allRows, overflow };
  }, [message.content, maxLines, paneWidth]);
  const role = message.role === "user" ? "YOU" : "FORGE";
  const color = message.role === "user" ? theme.accent : theme.success;
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold color={color}>{role}</Text>
    {rows.map((line, index) => {
      const code = /^\s{4}|^```/.test(line);
      const heading = /^#{1,6}\s/.test(line);
      return <Text key={index} color={code ? theme.code : theme.text} bold={heading} wrap="truncate-end">{line || " "}</Text>;
    })}
    {overflow > 0 && <Text color={theme.muted}>…{overflow} more line(s) — Ctrl+Y for the full untruncated conversation</Text>}
  </Box>;
}

interface FrameDimensions { columns: number; rows: number }

/**
 * Full-screen frame shell shared by every modal-like view (overlay lists,
 * approval, key entry, the reader). Replacing the chat view outright — rather
 * than layering a partially-transparent box on top of it — is deliberate:
 * Ink has no real background fill, so a floating box over live content lets
 * conversation text bleed through the gaps and around the edges, which reads
 * as visual noise stacked on top of the modal's own text.
 */
function Frame({ dimensions, title, titleColor, footer, children }: { dimensions: FrameDimensions; title: string; titleColor?: string; footer?: string; children: React.ReactNode }): React.ReactElement {
  return <Box flexDirection="column" height={dimensions.rows} width={dimensions.columns} paddingX={2} paddingY={1}>
    <Text bold inverse color={titleColor}> {title} </Text>
    <Text> </Text>
    <Box flexDirection="column" flexGrow={1}>{children}</Box>
    {footer && <Text color="gray">{footer}</Text>}
  </Box>;
}

function Overlay({ dimensions, title, query, items, selected, theme, footer, itemRefs }: { dimensions: FrameDimensions; title: string; query: string; items: SelectItem[]; selected: number; theme: ReturnType<typeof getTheme>; footer: string; itemRefs?: React.MutableRefObject<Map<number, DOMElement>> }): React.ReactElement {
  const visibleCount = Math.max(6, dimensions.rows - 9);
  const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), Math.max(0, items.length - visibleCount)));
  return <Frame dimensions={dimensions} title={`FORGE · ${title}`} titleColor={theme.accent} footer={footer}>
    <Box flexDirection="column" flexGrow={1}>
      <Text color={theme.text}>Search: {sanitizeTerminalText(query)}█</Text>
      <Text color={theme.muted}>{"─".repeat(Math.min(70, dimensions.columns - 4))}</Text>
      {items.slice(start, start + visibleCount).map((item, index) => {
        const absolute = start + index;
        return <Box key={item.id} ref={(node) => { if (node) itemRefs?.current.set(absolute, node); else itemRefs?.current.delete(absolute); }}><Text color={absolute === selected ? theme.accent : theme.text} inverse={absolute === selected} wrap="truncate-end">
          {absolute === selected ? " › " : "   "}{sanitizeTerminalText(item.label)}{item.detail ? `  ${sanitizeTerminalText(item.detail)}` : ""}
        </Text></Box>;
      })}
      {!items.length && <Text color={theme.muted}>No items available.</Text>}
    </Box>
  </Frame>;
}

function DiffPreview({ diff, theme, maxLines }: { diff: string; theme: ReturnType<typeof getTheme>; maxLines: number }): React.ReactElement {
  const lines = diff.split("\n");
  const visible = lines.slice(0, maxLines);
  return <Box flexDirection="column">
    {visible.map((line, index) => {
      const color = line.startsWith("+") && !line.startsWith("+++") ? theme.success
        : line.startsWith("-") && !line.startsWith("---") ? theme.danger
        : line.startsWith("@@") ? theme.accent
        : theme.muted;
      return <Text key={index} color={color} wrap="truncate-end">{line || " "}</Text>;
    })}
    {lines.length > maxLines && <Text color={theme.muted}>…{lines.length - maxLines} more line(s) not shown</Text>}
  </Box>;
}

function ApprovalModal({ dimensions, state, choice, theme, allowRef, denyRef }: { dimensions: FrameDimensions; state: ApprovalState; choice: "allow" | "deny"; theme: ReturnType<typeof getTheme>; allowRef?: React.Ref<DOMElement>; denyRef?: React.Ref<DOMElement> }): React.ReactElement {
  const args = summarizeToolArguments(state.request.activity.args);
  const diff = state.request.activity.diff;
  return <Frame dimensions={dimensions} title={`APPROVAL REQUIRED · ${state.request.activity.risk.toUpperCase()}`} titleColor={theme.warning} footer="←/→ or Tab to choose, Enter to confirm · Y allows · N/Esc denies">
    <Text bold>{state.request.activity.name}</Text>
    <Text color={theme.muted} wrap="wrap">{args}</Text>
    <Text> </Text>
    {diff && <DiffPreview diff={diff} theme={theme} maxLines={Math.max(4, dimensions.rows - 16)} />}
    {diff && <Text> </Text>}
    <Box gap={2}>
      <Box ref={allowRef}><Text color={theme.success} inverse={choice === "allow"} bold={choice === "allow"}>{choice === "allow" ? "› [ Allow once ]" : "  [ Allow once ]"}</Text></Box>
      <Box ref={denyRef}><Text color={theme.danger} inverse={choice === "deny"} bold={choice === "deny"}>{choice === "deny" ? "› [ Deny ]" : "  [ Deny ]"}</Text></Box>
    </Box>
    <Text> </Text>
    <Text color={theme.muted} wrap="wrap">Mouse clicks need capture mode on (Ctrl+T); the keyboard always works here.</Text>
  </Frame>;
}

function KeyEntryModal({ dimensions, name, mode, draft, theme }: { dimensions: FrameDimensions; name: string; mode: "add" | "update"; draft: string; theme: ReturnType<typeof getTheme> }): React.ReactElement {
  return <Frame dimensions={dimensions} title={mode === "add" ? `NEW PROVIDER · ${name}` : `UPDATE KEY · ${name}`} titleColor={theme.accent} footer="Enter to save · Esc to cancel">
    <Text color={theme.muted} wrap="wrap">Paste or type the API key. It is masked here and never added to composer history.</Text>
    <Text> </Text>
    <Text color={theme.text}>{"•".repeat(draft.length)}█</Text>
  </Frame>;
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
function readTerminalSize(stdout: { columns?: number; rows?: number }): { columns: number; rows: number } {
  return { columns: Math.max(40, (stdout.columns ?? 121) - 1), rows: stdout.rows ?? 30 };
}

export function ForgeTui({ config }: { config: ForgeConfig }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = React.useState(() => readTerminalSize(stdout));
  const [input, setInput] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [streamText, setStreamText] = React.useState("");
  const [revision, setRevision] = React.useState(0);
  const [notice, setNotice] = React.useState("Ready");
  const [activities, setActivities] = React.useState<ToolActivity[]>([]);
  const [approval, setApproval] = React.useState<ApprovalState | null>(null);
  const [approvalChoice, setApprovalChoice] = React.useState<"allow" | "deny">("deny");
  const [keyEntry, setKeyEntry] = React.useState<null | { mode: "add" | "update"; name: string; baseURL: string; format: Profile["format"]; model: string; draft: string }>(null);
  const [overlay, setOverlay] = React.useState<TuiOverlay | null>(null);
  const [overlayQuery, setOverlayQuery] = React.useState("");
  const [overlayItems, setOverlayItems] = React.useState<SelectItem[]>([]);
  const [selected, setSelected] = React.useState(0);
  const [focus, setFocus] = React.useState<TuiFocus>("composer");
  const [selectedActivity, setSelectedActivity] = React.useState(0);
  const [reader, setReader] = React.useState<ReaderState | null>(null);
  const [readerOffset, setReaderOffset] = React.useState(0);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [queuedPrompt, setQueuedPrompt] = React.useState("");
  const [usage, setUsage] = React.useState<AgentUsage>({ promptTokens: 0, completionTokens: 0 });
  const [subscriptionTokensUsed, setSubscriptionTokensUsed] = React.useState(() => {
    const entry = loadUsageLedger().profiles[config.activeProfile];
    return entry ? entry.promptTokens + entry.completionTokens : 0;
  });
  const [pricing, setPricing] = React.useState<ModelInfo | undefined>();
  const contextFilesRef = React.useRef(new Map<string, string>());
  const pastedBlocksRef = React.useRef(new Map<string, string>());
  const pasteCounterRef = React.useRef(0);
  const approvalRef = React.useRef<ApprovalState | null>(null);
  const queuedPromptRef = React.useRef("");
  const streamBufferRef = React.useRef("");
  const streamFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationAbortRef = React.useRef<AbortController | null>(null);
  const messagesRef = React.useRef<ChatMessage[]>(systemMessages(config));
  const sessionRef = React.useRef<AgentSession | null>(null);
  const activityPaneRef = React.useRef<DOMElement>(null!);
  const conversationPaneRef = React.useRef<DOMElement>(null!);
  const contextPaneRef = React.useRef<DOMElement>(null!);
  const composerRef = React.useRef<DOMElement>(null!);
  const approvalAllowRef = React.useRef<DOMElement>(null!);
  const approvalDenyRef = React.useRef<DOMElement>(null!);
  const overlayItemRefs = React.useRef(new Map<number, DOMElement>());
  const activityItemRefs = React.useRef(new Map<number, DOMElement>());
  const commandButtonRef = React.useRef<DOMElement>(null!);
  const filesButtonRef = React.useRef<DOMElement>(null!);
  const modelsButtonRef = React.useRef<DOMElement>(null!);
  const sessionsButtonRef = React.useRef<DOMElement>(null!);
  const helpButtonRef = React.useRef<DOMElement>(null!);
  const mouseButtonRef = React.useRef<DOMElement>(null!);
  const modeButtonRef = React.useRef<DOMElement>(null!);
  const readerButtonRef = React.useRef<DOMElement>(null!);
  const statusButtonRef = React.useRef<DOMElement>(null!);
  const theme = getTheme(config.ui.theme);

  React.useEffect(() => {
    if (!config.ui.mouse || !stdout.isTTY) return;
    stdout.write(ENABLE_MOUSE_TRACKING);
    return () => { stdout.write(DISABLE_MOUSE_TRACKING); };
  }, [config.ui.mouse, stdout]);

  const requestApproval = React.useCallback((request: ApprovalRequest): Promise<boolean> => new Promise((resolve) => {
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
    if (!queued) return;
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
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    streamBufferRef.current = "";
  }, []);

  React.useEffect(() => {
    const unsubscribe = session.subscribe((event: AgentEvent) => {
      if (event.type === "turn.started") { clearStreamBuffer(); setBusy(true); setStreamText(""); setNotice("Thinking…"); setRevision((value) => value + 1); }
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
            if (pending) setStreamText((value) => value + pending);
          }, 50);
        }
      }
      else if (event.type === "message.completed") {
        clearStreamBuffer();
        setStreamText("");
        saveSession("autosave", messagesRef.current);
        setRevision((value) => value + 1);
      }
      else if (event.type === "tool.requested") setActivities((items) => [event.activity, ...items.filter((item) => item.id !== event.activity.id)].slice(0, 20));
      else if (event.type === "tool.updated") setActivities((items) => [event.activity, ...items.filter((item) => item.id !== event.activity.id)].slice(0, 20));
      else if (event.type === "usage.updated") {
        setUsage({ ...event.usage });
        const entry = loadUsageLedger().profiles[config.activeProfile];
        setSubscriptionTokensUsed(entry ? entry.promptTokens + entry.completionTokens : 0);
      }
      else if (event.type === "turn.failed") {
        const pending = streamBufferRef.current;
        clearStreamBuffer();
        if (pending) setStreamText((value) => value + pending);
        setBusy(false); setNotice(`Error: ${sanitizeTerminalText(event.error.message)}`);
      }
      else if (event.type === "turn.cancelled") {
        const pending = streamBufferRef.current;
        clearStreamBuffer();
        if (pending) setStreamText((value) => value + pending);
        setBusy(false); setNotice("Cancelled");
      }
      else if (event.type === "turn.completed") {
        setBusy(false); setNotice("Ready"); setRevision((value) => value + 1);
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
    if (!overlay) { setOverlayItems([]); return; }
    if (overlay === "help" || overlay === "commands") {
      setOverlayItems(SLASH_COMMANDS.map((command) => ({ id: command.name, label: command.usage, detail: command.description })));
    } else if (overlay === "models") {
      setOverlayItems(Object.entries(config.profiles).map(([name, profile]) => ({ id: `profile:${name}`, label: `${name}: ${profile.model}`, detail: profile.kind })));
      listRuntimeSummaries(config).then((summaries) => setOverlayItems((items) => [
        ...items,
        ...summaries.flatMap((runtime) => runtime.models.map((model) => ({ id: `${runtime.kind}:${model.id}`, label: `${runtime.kind}:${model.id}`, detail: runtime.health.healthy ? "local · online" : "local · offline" }))),
      ])).catch(() => undefined);
    } else if (overlay === "context") {
      fg("**/*", { cwd: config.permissions.workspaceRoot, onlyFiles: true, dot: false, ignore: [".git/**", "node_modules/**", "dist/**"] })
        .then((files) => setOverlayItems(files.slice(0, 500).map((file) => ({ id: file, label: file, detail: contextFilesRef.current.has(file) ? "pinned" : undefined })))).catch(() => setOverlayItems([]));
    } else if (overlay === "sessions") {
      setOverlayItems(listSessions().map((name) => ({ id: name, label: name })));
    }
  }, [overlay, config]);

  const filteredOverlayItems = React.useMemo(() => {
    const query = overlayQuery.trim().toLowerCase();
    if (!query) return overlayItems;
    return overlayItems.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query));
  }, [overlayItems, overlayQuery]);

  const cyclePermissionMode = React.useCallback(() => {
    const order: PermissionMode[] = ["read-only", "balanced", "autonomous"];
    config.permissions.mode = order[(order.indexOf(config.permissions.mode) + 1) % order.length];
    saveConfig(config);
    setNotice(`Permission mode set to ${config.permissions.mode}.`);
    setRevision((value) => value + 1);
  }, [config]);

  const closeApproval = React.useCallback((allowed: boolean) => {
    const current = approvalRef.current;
    if (!current) return;
    approvalRef.current = null;
    setApproval(null);
    if (allowed && ["write", "process", "external"].includes(current.request.activity.risk)) {
      saveSession("recovery-latest", messagesRef.current);
    }
    current.resolve(allowed);
  }, []);

  const selectOverlayItem = React.useCallback((selection = selected) => {
    const item = filteredOverlayItems[selection];
    if (!item || !overlay) return;
    if (overlay === "commands" || overlay === "help") {
      setInput(`/${item.id} `); setCursor(item.id.length + 2); setOverlay(null);
    } else if (overlay === "models") {
      if (item.id.startsWith("profile:")) config.activeProfile = item.id.slice(8);
      else {
        const runtime = item.id.slice(0, item.id.indexOf(":"));
        const model = item.id.slice(item.id.indexOf(":") + 1);
        const name = `local-${runtime}`;
        const runtimeConfig = config.runtimes[runtime as keyof typeof config.runtimes];
        config.profiles[name] = { kind: "local", runtime: runtime as Profile["runtime"], baseURL: runtimeConfig.baseURL, apiKey: runtime === "ollama" ? "ollama" : "local", format: "openai", model };
        config.activeProfile = name;
      }
      saveConfig(config); setNotice(`Using ${config.activeProfile}: ${config.profiles[config.activeProfile].model}`); setOverlay(null); setRevision((value) => value + 1);
    } else if (overlay === "context") {
      try {
        const full = resolveWorkspacePath(config.permissions.workspaceRoot, item.id);
        contextFilesRef.current.set(item.id, fs.readFileSync(full, "utf-8").slice(0, 48_000));
        setNotice(`Pinned ${item.id}`); setOverlay(null); setRevision((value) => value + 1);
      } catch (error) { setNotice(`Could not pin file: ${error instanceof Error ? error.message : String(error)}`); }
    } else if (overlay === "sessions") {
      try {
        messagesRef.current.splice(0, messagesRef.current.length, ...loadSession(item.id));
        setNotice(`Loaded ${item.id}`); setOverlay(null); setRevision((value) => value + 1);
      } catch { setNotice(`Could not load ${item.id}`); }
    }
  }, [config, filteredOverlayItems, overlay, selected]);

  const finishKeyEntry = React.useCallback((cancelled: boolean) => {
    setKeyEntry((current) => {
      if (!current) return null;
      if (cancelled) { setNotice(current.mode === "add" ? "Provider setup cancelled." : "Key entry cancelled."); return null; }
      if (!current.draft) { setNotice("No key entered — nothing changed."); return null; }
      try {
        config.profiles[current.name] = { baseURL: current.baseURL, apiKey: current.draft, format: current.format, model: current.model, kind: "remote" };
        saveConfig(config);
        setNotice(current.mode === "add" ? `Provider "${current.name}" added.` : `API key updated for "${current.name}".`);
        setRevision((value) => value + 1);
      } catch (error) {
        setNotice(`Could not save provider: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    });
  }, [config]);

  const submit = React.useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    const value = expandPastedBlocks(trimmed, pastedBlocksRef.current);
    pastedBlocksRef.current.clear();
    setInput(""); setCursor(0); setScrollOffset(0);
    if (busy) {
      queuedPromptRef.current = value;
      setQueuedPrompt(value);
      setNotice("Prompt queued for the next turn");
      return;
    }
    let command: ReturnType<typeof executeTuiCommand>;
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
    } catch (error) {
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
    if (command.type === "exit") { exit(); return; }
    if (command.type === "overlay") { setOverlay(command.overlay); return; }
    if (command.type === "notice") { setNotice(command.message); setRevision((revision) => revision + 1); return; }
    if (command.type === "clear") { messagesRef.current.splice(0, messagesRef.current.length, ...systemMessages(config)); setActivities([]); setNotice("New conversation"); setRevision((revision) => revision + 1); return; }
    if (command.type === "load") { messagesRef.current.splice(0, messagesRef.current.length, ...command.messages); setNotice(`Loaded ${command.name}`); setRevision((revision) => revision + 1); return; }
    if (command.type === "undo") {
      const entry = popUndo(config.permissions.workspaceRoot);
      if (!entry) { setNotice("Nothing to undo."); return; }
      try {
        const touched = applyUndo(config.permissions.workspaceRoot, entry);
        setNotice(`Undid ${entry.tool}: ${touched.join(", ")}.`);
      } catch (error) { setNotice(`Undo failed: ${error instanceof Error ? error.message : String(error)}`); }
      setRevision((value) => value + 1);
      return;
    }
    if (command.type === "compact") {
      const history = messagesRef.current.filter((message) => message.role !== "system");
      if (history.length < 2) { setNotice("Nothing to compact yet."); return; }
      setBusy(true); setNotice("Compacting conversation…");
      operationAbortRef.current = new AbortController();
      try {
        const driver = createDriver(profile);
        let summary = "";
        let failure: Error | undefined;
        await driver.streamChat(
          [...history, { role: "user", content: "Summarize this entire conversation concisely but completely: the goal, key decisions, code or file changes made, current state, and any open next steps. Write it as a standalone note — it will fully replace this conversation's history to free up context, so do not omit anything a continuation would need." }],
          [],
          profile.model,
          { onTextDelta: (delta) => { summary += delta; }, onToolCallsComplete: () => {}, onDone: () => {}, onError: (error) => { failure = error; } },
          operationAbortRef.current.signal,
        );
        if (failure) throw failure;
        const before = estimateMessageTokens(messagesRef.current);
        messagesRef.current.splice(0, messagesRef.current.length, ...systemMessages(config), { role: "assistant", content: `[Conversation compacted from ${history.length} messages]\n\n${summary.trim()}` });
        const after = estimateMessageTokens(messagesRef.current);
        setNotice(`Compacted ${history.length} messages (~${before.toLocaleString("en-US")} → ~${after.toLocaleString("en-US")} tokens).`);
      } catch (error) { setNotice(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { operationAbortRef.current = null; setBusy(false); setRevision((value) => value + 1); flushQueuedPrompt(); }
      return;
    }
    if (command.type === "model-info") {
      setBusy(true); setNotice(`Inspecting ${command.reference}…`);
      try {
        const capabilities = await inspectLocalModel(config, command.reference);
        setNotice(`${command.reference}: ${Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name).join(", ") || "chat"}`);
      } catch (error) { setNotice(`Model inspection failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { setBusy(false); flushQueuedPrompt(); }
      return;
    }
    if (command.type === "model-pull") {
      const allowed = await requestApproval({
        call: { id: `pull-${Date.now()}`, name: "model_pull", arguments: JSON.stringify({ reference: command.reference }) },
        activity: { id: `pull-${Date.now()}`, name: "model_pull", risk: "external", status: "waiting", args: { reference: command.reference }, startedAt: Date.now() },
      });
      if (!allowed) { setNotice("Model download denied."); return; }
      setBusy(true);
      operationAbortRef.current = new AbortController();
      try {
        for await (const progress of pullLocalModel(config, command.reference, operationAbortRef.current.signal)) {
          const percent = progress.total && progress.completed ? ` ${Math.floor((progress.completed / progress.total) * 100)}%` : "";
          setNotice(`${progress.status}${percent}`);
        }
        setNotice(`Downloaded ${command.reference}.`);
      } catch (error) { setNotice(`Model download failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { operationAbortRef.current = null; setBusy(false); flushQueuedPrompt(); }
      return;
    }
    if (command.type === "runtime") {
      if (command.operation === "list" || command.operation === "status") {
        setBusy(true);
        try {
          const summaries = await listRuntimeSummaries(config);
          setNotice(summaries.map((item) => `${item.kind} ${item.health.healthy ? "online" : "offline"} (${item.models.length})`).join(" · "));
        } catch (error) { setNotice(`Runtime status failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally { setBusy(false); flushQueuedPrompt(); }
        return;
      }
      if (!command.kind || !(command.kind in config.runtimes)) { setNotice("Usage: /runtime start|stop <ollama|lmstudio|llamacpp|openai-compatible> [model-path]"); return; }
      const allowed = await requestApproval({
        call: { id: `runtime-${Date.now()}`, name: `runtime_${command.operation}`, arguments: JSON.stringify({ kind: command.kind, modelPath: command.modelPath }) },
        activity: { id: `runtime-${Date.now()}`, name: `runtime_${command.operation}`, risk: "process", status: "waiting", args: { kind: command.kind, modelPath: command.modelPath }, startedAt: Date.now() },
      });
      if (!allowed) { setNotice("Runtime operation denied."); return; }
      setBusy(true);
      try {
        if (command.operation === "start") {
          const result = await startRuntime(config, command.kind as keyof typeof config.runtimes, { modelPath: command.modelPath });
          setNotice(result.owned ? `Started ${command.kind} (PID ${result.pid}).` : `${command.kind} is already online.`);
        } else {
          await stopOwnedRuntime(config, command.kind as keyof typeof config.runtimes);
          setNotice(`Stopped ${command.kind}.`);
        }
      } catch (error) { setNotice(`Runtime operation failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { setBusy(false); flushQueuedPrompt(); }
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
          if (!tool) { setNotice(`Tool ${requested.name} is unavailable.`); break; }
          const decision = decidePermission(config.permissions.mode, tool.risk);
          if (decision === "deny") { setNotice(`${config.permissions.mode} mode blocks ${tool.risk} tools.`); break; }
          if (decision === "ask") {
            const id = `command-${Date.now()}-${index}`;
            let diff: string | undefined;
            try { diff = tool.preview?.(requested.args); } catch { /* preview is best-effort */ }
            const allowed = await requestApproval({
              call: { id, name: tool.def.name, arguments: JSON.stringify(requested.args) },
              activity: { id, name: tool.def.name, risk: tool.risk, status: "waiting", args: requested.args, diff, startedAt: Date.now() },
            });
            if (!allowed) { setNotice("Command denied."); break; }
          }
          const activity: ToolActivity = { id: `command-${Date.now()}-${index}`, name: tool.def.name, risk: tool.risk, status: "running", args: requested.args, startedAt: Date.now() };
          setActivities((items) => [activity, ...items].slice(0, 20));
          try {
            setNotice(requestedTools.length > 1 ? `Check ${index + 1}/${requestedTools.length}: ${tool.def.name}` : `Running ${tool.def.name}...`);
            const result = await tool.execute(requested.args, operationAbortRef.current.signal);
            activity.status = "completed"; activity.result = result; activity.durationMs = Date.now() - activity.startedAt;
            messagesRef.current.push({ role: "assistant", content: `Command output (${tool.def.name}):\n${result}` });
            setNotice(requestedTools.length > 1 ? `Check ${index + 1}/${requestedTools.length} completed.` : `${tool.def.name} completed.`);
          } catch (error) {
            activity.status = "failed"; activity.result = error instanceof Error ? error.message : String(error); activity.durationMs = Date.now() - activity.startedAt;
            setNotice(`${tool.def.name} failed: ${activity.result}`);
            break;
          } finally {
            setActivities((items) => [{ ...activity }, ...items.filter((item) => item.id !== activity.id)].slice(0, 20));
          }
        }
      } finally {
        operationAbortRef.current = null; setBusy(false); setRevision((revision) => revision + 1); flushQueuedPrompt();
      }
      return;
    }
    try {
      await session.send(command.type === "prompt" ? command.prompt : value);
    } catch (error) {
      setBusy(false);
      setNotice(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [busy, config, exit, flushQueuedPrompt, input, requestApproval, session]);

  const openReader = React.useCallback((pane: TuiFocus = focus) => {
    let title: string;
    let content: string;
    if (pane === "activity") {
      title = "ACTIVITY";
      const selectedItem = activities[selectedActivity];
      content = selectedItem
        ? `${selectedItem.name}\nstatus: ${selectedItem.status}\nrisk: ${selectedItem.risk}\nduration: ${selectedItem.durationMs ?? "pending"} ms\narguments: ${JSON.stringify(selectedItem.args, null, 2)}\n\n${selectedItem.result ?? "No result available."}`
        : activities.map((item) => `${statusSymbol(item.status)} ${item.name} · ${item.status}${item.durationMs != null ? ` · ${item.durationMs} ms` : ""}`).join("\n") || "No tool activity yet.";
    } else if (pane === "context") {
      title = "CONTEXT / SESSION";
      const pinned = Array.from(contextFilesRef.current, ([file, value]) => `${file} (${value.length} chars)`).join("\n") || "No pinned files.";
      content = `SESSION\n${busy ? "Working" : "Ready"}\n\nLATEST STATUS / ERROR\n${formatReaderStatus(notice)}\n\nWORKSPACE\n${config.permissions.workspaceRoot}\n\nPINNED FILES\n${pinned}`;
    } else if (pane === "composer") {
      title = "COMPOSER";
      content = input || "The composer is empty.";
    } else {
      title = "CONVERSATION";
      content = messagesRef.current.filter((message) => message.role !== "system").map((message) => `${message.role === "user" ? "YOU" : message.role === "assistant" ? "FORGE" : `TOOL ${message.name ?? "RESULT"}`}\n\n${message.content}`).join("\n\n---\n\n") || "No conversation messages yet.";
      if (streamText) content += `${content ? "\n\n---\n\n" : ""}FORGE (streaming)\n\n${streamText}`;
    }
    if (config.ui.mouse) { config.ui.mouse = false; saveConfig(config); }
    setReader({ title, content: sanitizeTerminalText(content) });
    setReaderOffset(0);
    setRevision((value) => value + 1);
  }, [activities, busy, config, focus, input, notice, selectedActivity, streamText]);

  // Shared by useInput's fallback branch and usePaste below: route pasted
  // text to whichever surface is actually active, and collapse a large
  // composer paste to a placeholder so it never has to be rendered inline.
  const insertPastedText = React.useCallback((text: string) => {
    if (reader || approval) return;
    if (keyEntry) { setKeyEntry((current) => current && { ...current, draft: current.draft + text }); return; }
    if (overlay) { setOverlayQuery((value) => value + text); setSelected(0); return; }
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
      if (key.ctrl && character === "c") { exit(); return; }
      if (key.escape || (key.ctrl && character === "y")) { setReader(null); setReaderOffset(0); return; }
      if (key.pageUp || key.upArrow) { setReaderOffset((value) => Math.max(0, value - (key.pageUp ? page : 1))); return; }
      if (key.pageDown || key.downArrow) { setReaderOffset((value) => Math.min(Math.max(0, readerLines.length - page), value + (key.pageDown ? page : 1))); return; }
      if (key.home) { setReaderOffset(0); return; }
      if (key.end) { setReaderOffset(Math.max(0, readerLines.length - page)); return; }
      return;
    }
    if (keyEntry) {
      if (key.ctrl && character === "c") { exit(); return; }
      if (key.escape) { finishKeyEntry(true); return; }
      if (key.return) { finishKeyEntry(false); return; }
      if (key.backspace || key.delete) { setKeyEntry((current) => current && { ...current, draft: current.draft.slice(0, -1) }); return; }
      if (!key.ctrl && !key.meta && character) { setKeyEntry((current) => current && { ...current, draft: current.draft + character }); }
      return;
    }
    const mouse = config.ui.mouse ? parseMouseInput(character) : undefined;
    if (mouse) {
      const metrics = (ref: React.RefObject<DOMElement>) => ref.current ? measureElement(ref.current) : undefined;
      if (approval) {
        if (mouse.action === "press" && mouse.button === "left") {
          if (containsPoint(metrics(approvalAllowRef), mouse.x, mouse.y)) closeApproval(true);
          else if (containsPoint(metrics(approvalDenyRef), mouse.x, mouse.y)) closeApproval(false);
        }
        return;
      }
      if (overlay) {
        if (mouse.action === "wheel") {
          setSelected((value) => Math.max(0, Math.min(filteredOverlayItems.length - 1, value + (mouse.button === "wheel-down" ? 1 : -1))));
        } else if (mouse.action === "press" && mouse.button === "left") {
          for (const [index, node] of overlayItemRefs.current) {
            if (containsPoint(measureElement(node), mouse.x, mouse.y)) { setSelected(index); selectOverlayItem(index); return; }
          }
        }
        return;
      }
      if (mouse.action === "wheel") {
        if (containsPoint(metrics(activityPaneRef), mouse.x, mouse.y)) {
          setFocus("activity");
          setSelectedActivity((value) => Math.max(0, Math.min(activities.length - 1, value + (mouse.button === "wheel-down" ? 1 : -1))));
        } else {
          setFocus("conversation");
          setScrollOffset((value) => Math.max(0, value + (mouse.button === "wheel-up" ? 3 : -3)));
        }
        return;
      }
      if (mouse.action === "press" && mouse.button === "right") {
        if (containsPoint(metrics(activityPaneRef), mouse.x, mouse.y)) openReader("activity");
        else if (containsPoint(metrics(contextPaneRef), mouse.x, mouse.y)) openReader("context");
        else if (containsPoint(metrics(conversationPaneRef), mouse.x, mouse.y)) openReader("conversation");
        else if (containsPoint(metrics(composerRef), mouse.x, mouse.y)) openReader("composer");
        return;
      }
      if (mouse.action !== "press" || mouse.button !== "left") return;
      if (containsPoint(metrics(commandButtonRef), mouse.x, mouse.y)) { setOverlay("commands"); return; }
      if (containsPoint(metrics(filesButtonRef), mouse.x, mouse.y)) { setOverlay("context"); return; }
      if (containsPoint(metrics(modelsButtonRef), mouse.x, mouse.y)) { setOverlay("models"); return; }
      if (containsPoint(metrics(sessionsButtonRef), mouse.x, mouse.y)) { setOverlay("sessions"); return; }
      if (containsPoint(metrics(helpButtonRef), mouse.x, mouse.y)) { setOverlay("help"); return; }
      if (containsPoint(metrics(mouseButtonRef), mouse.x, mouse.y)) {
        config.ui.mouse = false; saveConfig(config); setNotice("Mouse capture off — drag to select text; Ctrl+T turns it back on."); setRevision((value) => value + 1); return;
      }
      if (containsPoint(metrics(modeButtonRef), mouse.x, mouse.y)) { cyclePermissionMode(); return; }
      if (containsPoint(metrics(readerButtonRef), mouse.x, mouse.y)) { openReader(); return; }
      if (containsPoint(metrics(statusButtonRef), mouse.x, mouse.y)) { openReader("context"); return; }
      for (const [index, node] of activityItemRefs.current) {
        if (containsPoint(measureElement(node), mouse.x, mouse.y)) { setFocus("activity"); setSelectedActivity(index); return; }
      }
      if (containsPoint(metrics(activityPaneRef), mouse.x, mouse.y)) { setFocus("activity"); return; }
      if (containsPoint(metrics(contextPaneRef), mouse.x, mouse.y)) { setFocus("context"); setOverlay("context"); return; }
      if (containsPoint(metrics(conversationPaneRef), mouse.x, mouse.y)) { setFocus("conversation"); return; }
      if (containsPoint(metrics(composerRef), mouse.x, mouse.y)) { setFocus("composer"); return; }
      return;
    }
    if (approval) {
      if (character.toLowerCase() === "y") closeApproval(true);
      else if (character.toLowerCase() === "n" || key.escape) closeApproval(false);
      else if (key.return) closeApproval(approvalChoice === "allow");
      else if (key.leftArrow || key.rightArrow || key.tab || key.upArrow || key.downArrow) setApprovalChoice((value) => (value === "allow" ? "deny" : "allow"));
      return;
    }
    if (key.ctrl && character === "c") { if (busy) { session.cancel(); operationAbortRef.current?.abort(); } else exit(); return; }
    if (key.escape) { if (overlay) setOverlay(null); else if (busy) { session.cancel(); operationAbortRef.current?.abort(); } return; }
    if (key.ctrl && character === "k") { setOverlay("commands"); return; }
    if (key.ctrl && character === "m") { setOverlay("models"); return; }
    if (key.ctrl && character === "p") { setOverlay("context"); return; }
    if (key.ctrl && character === "s") { setOverlay("sessions"); return; }
    if (key.ctrl && character === "t") {
      config.ui.mouse = !config.ui.mouse;
      saveConfig(config);
      setNotice(config.ui.mouse ? "Mouse capture on — click controls; Shift+drag may select text in supported terminals." : "Mouse capture off — drag to select and copy text normally.");
      setRevision((value) => value + 1);
      return;
    }
    if (key.ctrl && character === "a") { cyclePermissionMode(); return; }
    if (key.ctrl && character === "y") { openReader(); return; }
    if (key.ctrl && character === "e") { openReader("context"); return; }
    if (key.tab) {
      const order: TuiFocus[] = wide ? ["activity", "conversation", "context", "composer"] : medium ? ["conversation", "context", "composer"] : ["conversation", "composer"];
      setFocus((current) => order[(order.indexOf(current) + 1) % order.length]);
      return;
    }
    if (overlay) {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setSelected((value) => Math.max(0, Math.min(filteredOverlayItems.length - 1, value + 1)));
      else if (key.return) selectOverlayItem();
      else if (key.backspace || key.delete) { setOverlayQuery((value) => value.slice(0, -1)); setSelected(0); }
      else if (!key.ctrl && !key.meta && character) { setOverlayQuery((value) => value + character); setSelected(0); }
      return;
    }
    if (character === "?" && !input) { setOverlay("help"); return; }
    if (focus === "activity") {
      if (key.upArrow) { setSelectedActivity((value) => Math.max(0, value - 1)); return; }
      if (key.downArrow) { setSelectedActivity((value) => Math.max(0, Math.min(activities.length - 1, value + 1))); return; }
      if (key.return) {
        const item = activities[selectedActivity];
        if (item) setNotice(`${item.name}: ${item.result ? sanitizeTerminalText(item.result).slice(0, 300) : item.status}`);
        return;
      }
    }
    if (focus === "conversation" && (key.upArrow || key.downArrow)) {
      setScrollOffset((value) => Math.max(0, value + (key.upArrow ? 1 : -1)));
      return;
    }
    if (focus === "context" && key.return) { setOverlay("context"); return; }
    if (key.pageUp) { setScrollOffset((value) => value + 5); return; }
    if (key.pageDown) { setScrollOffset((value) => Math.max(0, value - 5)); return; }
    if (focus !== "composer" && key.return) { setFocus("composer"); return; }
    if (focus !== "composer" && (key.leftArrow || key.rightArrow || key.backspace || key.delete)) return;
    if (focus !== "composer" && !key.ctrl && !key.meta && character) setFocus("composer");
    if (key.ctrl && character === "j") { setInput((value) => value.slice(0, cursor) + "\n" + value.slice(cursor)); setCursor((value) => value + 1); return; }
    if (key.return) { void submit(); return; }
    if (key.leftArrow) { setCursor((value) => Math.max(0, value - 1)); return; }
    if (key.rightArrow) { setCursor((value) => Math.min(input.length, value + 1)); return; }
    if (key.backspace || key.delete) {
      if (cursor > 0) { setInput((value) => value.slice(0, cursor - 1) + value.slice(cursor)); setCursor((value) => value - 1); }
      return;
    }
    if (!key.ctrl && !key.meta && character) {
      // Real pastes go through usePaste below (bracketed paste mode delivers
      // the whole blob atomically, however many raw chunks the terminal
      // split it into). This branch only still sees large text if the
      // terminal doesn't support bracketed paste at all — same collapse
      // logic as a fallback.
      if (character.length > PASTE_COLLAPSE_THRESHOLD) { insertPastedText(character); return; }
      setInput((value) => value.slice(0, cursor) + character + value.slice(cursor));
      setCursor((value) => value + character.length);
    }
  });

  usePaste((text) => { insertPastedText(text); });

  const profile = config.profiles[config.activeProfile];
  const allMessages = messagesRef.current.filter((message) => message.role === "user" || message.role === "assistant");
  const displayMessages = streamText ? [...allMessages, { role: "assistant" as const, content: streamText }] : allMessages;
  const maxMessages = Math.max(2, Math.floor((dimensions.rows - 10) / 4));
  const messageMaxLines = Math.max(15, dimensions.rows - 10);
  const end = Math.max(0, displayMessages.length - scrollOffset);
  const visibleMessages = displayMessages.slice(Math.max(0, end - maxMessages), end);
  const wide = dimensions.columns >= 120;
  const medium = dimensions.columns >= 90;
  // Estimated inner width of the conversation pane, used to pre-wrap long
  // messages ourselves so a truncation cap can be enforced on rendered rows
  // rather than raw "\n"-delimited lines (a single very long line with no
  // newlines would otherwise ignore any line-count-based cap entirely).
  // Activity/context widths below are each pane's own declared `width`
  // (which already includes that pane's border+padding, confirmed against
  // Ink's actual layout output — not just their inner content width).
  // Conversation's own border(2)+paddingX(2) is subtracted separately since
  // it isn't a fixed-width pane; its share of the row comes from flexGrow.
  const conversationPaneWidth = Math.max(20, dimensions.columns - (wide ? 25 : 0) - (medium ? (wide ? 29 : 25) : 0) - 4);
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
    ? `Working… type to queue · Esc cancel${input ? `\n› ${cursorView}` : ""}`
    : `› ${cursorView}`;
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
    return <Box flexDirection="column" height={dimensions.rows} width={dimensions.columns}>
      <Text bold inverse>FORGE READER · {reader.title}</Text>
      <Text color={theme.muted}>Drag to select this pane only · Ctrl+Y/Esc close · ↑/↓ or PgUp/PgDn scroll · {readerOffset + 1}-{Math.min(readerLines.length, readerOffset + readerPageSize)}/{readerLines.length}</Text>
      <Text> </Text>
      {visibleReaderLines.map((line, index) => <Text key={`${readerOffset}-${index}`} wrap="truncate-end">{line || " "}</Text>)}
    </Box>;
  }

  // Each of these takes over the whole screen while active, then returns to
  // the chat view below once dismissed — see the Frame component for why.
  if (keyEntry) return <KeyEntryModal dimensions={dimensions} name={keyEntry.name} mode={keyEntry.mode} draft={keyEntry.draft} theme={theme} />;
  if (approval) return <ApprovalModal dimensions={dimensions} allowRef={approvalAllowRef} denyRef={approvalDenyRef} state={approval} choice={approvalChoice} theme={theme} />;
  if (overlay) return <Overlay dimensions={dimensions} itemRefs={overlayItemRefs} title={overlay.toUpperCase()} query={overlayQuery} items={filteredOverlayItems} selected={selected} theme={theme} footer="Type/filter · click or ↑/↓ + Enter · wheel scroll · Esc close" />;

  return <Box flexDirection="column" height={dimensions.rows} width={dimensions.columns}>
    <Box borderStyle="round" borderColor={theme.focusBorder} paddingX={1}>
      <Box flexShrink={0}><Text bold color={theme.accent}>◆ FORGE</Text></Box>
      {/* flexGrow+minWidth=0 forces Yoga to give this a real bounded width so
          wrap="truncate-end" has something to truncate against; without it,
          long workspace/profile/model names overflow the header and corrupt
          it character-for-character against "FORGE" instead of truncating. */}
      <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent="flex-end">
        <Text wrap="truncate-end"> {sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))} · {sanitizeTerminalText(config.activeProfile)}/{sanitizeTerminalText(profile.model)} · {profile.kind === "local" ? "● local" : "◉ cloud"} · {config.permissions.mode}{config.routing.offline ? " · offline" : ""}</Text>
      </Box>
    </Box>

    <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
      {wide && <Box ref={activityPaneRef} width={25} flexShrink={0} flexDirection="column" overflow="hidden" borderStyle="single" borderColor={focus === "activity" ? theme.focusBorder : theme.border} paddingX={1}>
        <Text bold color={theme.accent}>ACTIVITY</Text>
        {activities.slice(0, Math.max(3, dimensions.rows - 10)).map((item, index) => <Box key={item.id} ref={(node) => { if (node) activityItemRefs.current.set(index, node); else activityItemRefs.current.delete(index); }}><Text inverse={focus === "activity" && index === selectedActivity} color={item.status === "failed" ? theme.danger : item.status === "completed" ? theme.success : theme.warning} wrap="truncate-end">
          {statusSymbol(item.status)} {sanitizeTerminalText(item.name)} {item.durationMs != null ? `${item.durationMs}ms` : ""}
        </Text></Box>)}
        {!activities.length && <Text color={theme.muted}>Tool calls appear here.</Text>}
      </Box>}

      <Box ref={conversationPaneRef} flexGrow={1} flexShrink={1} flexBasis={0} flexDirection="column" overflow="hidden" borderStyle="single" borderColor={focus === "conversation" ? theme.focusBorder : theme.border} paddingX={1}>
        {visibleMessages.map((message, index) => <MessageBlock key={`${message.role}-${index}`} message={message} theme={theme} maxLines={messageMaxLines} paneWidth={conversationPaneWidth} />)}
        {!visibleMessages.length && <Box flexGrow={1} alignItems="center" justifyContent="center"><Text color={theme.muted}>Ask about this workspace, press Ctrl+K for commands, or Ctrl+M for models.</Text></Box>}
      </Box>

      {medium && <Box ref={contextPaneRef} width={wide ? 29 : 25} flexShrink={0} flexDirection="column" overflow="hidden" borderStyle="single" borderColor={focus === "context" ? theme.focusBorder : theme.border} paddingX={1}>
        <Text bold color={theme.accent}>CONTEXT</Text>
        <Text wrap="truncate-end">Workspace: {sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))}</Text>
        <Text>Instructions: {loadProjectInstructions(config.permissions.workspaceRoot).length}</Text>
        <Text>Pinned files: {contextFilesRef.current.size}</Text>
        <Text>Messages: {allMessages.length}</Text>
        <Text>Context: ~{estimateMessageTokens(messagesRef.current).toLocaleString("en-US")} tokens</Text>
        <Text color={theme.muted}>Ctrl+P add files</Text>
        <Box marginTop={1} flexDirection="column"><Text bold color={theme.accent}>SESSION</Text><Text>{busy ? "● Working" : "○ Ready"}</Text>
          {/* Bounded for the same reason as the composer: a long notice (a
              provider error body, say) would otherwise grow this pane and
              push the frame past the terminal's height. Ctrl+E opens the
              full text in the reader. */}
          {wrapReaderText(sanitizeTerminalText(notice), (wide ? 29 : 25) - 4).slice(0, 4).map((row, index) => (
            <Text key={index} color={theme.muted} wrap="truncate-end">{row || " "}</Text>
          ))}
        </Box>
      </Box>}
    </Box>

    <Box ref={composerRef} flexDirection="column" flexShrink={0} overflow="hidden" borderStyle="round" borderColor={busy ? theme.warning : focus === "composer" ? theme.focusBorder : theme.border} paddingX={1} minHeight={3}>
      {visibleComposerRows.map((row, index) => (
        <Text key={index} color={busy ? theme.warning : theme.text} wrap="truncate-end">{row || " "}</Text>
      ))}
      {hiddenComposerRows > 0 && <Text color={theme.muted} wrap="truncate-end">…{hiddenComposerRows} more line(s) in the composer</Text>}
    </Box>
    {suggestions.length > 0 && !overlay && <Text color={theme.muted}> {suggestions.join("  ")}</Text>}
    <Box paddingX={1} overflow="hidden">
      <Text color={limitExceeded ? theme.danger : theme.muted} bold={limitExceeded} wrap="truncate-end">{sanitizeTerminalText(usageLine)}</Text>
    </Box>
    {queuedPrompt && <Text color={theme.warning} wrap="truncate-end"> Queued: {sanitizeTerminalText(queuedPrompt)}</Text>}
    <Box paddingX={1} gap={1} overflow="hidden">
      <Box ref={commandButtonRef}><Text color={theme.muted}>[Cmd ^K]</Text></Box>
      <Box ref={filesButtonRef}><Text color={theme.muted}>[Files ^P]</Text></Box>
      <Box ref={modelsButtonRef}><Text color={theme.muted}>[Models ^M]</Text></Box>
      <Box ref={sessionsButtonRef}><Text color={theme.muted}>[Sessions ^S]</Text></Box>
      <Box ref={helpButtonRef}><Text color={theme.muted}>[Help ?]</Text></Box>
      <Box ref={readerButtonRef}><Text color={theme.muted}>[Reader ^Y]</Text></Box>
      <Box ref={statusButtonRef}><Text color={notice.startsWith("Error:") ? theme.danger : theme.muted}>[Status ^E]</Text></Box>
      <Box ref={mouseButtonRef}><Text color={config.ui.mouse ? theme.warning : theme.muted}>[Mouse {config.ui.mouse ? "on" : "off"} ^T]</Text></Box>
      <Box ref={modeButtonRef}><Text color={config.permissions.mode === "autonomous" ? theme.warning : theme.muted}>[Mode ^A]</Text></Box>
      <Text color={theme.muted}> Tab panes</Text>
    </Box>
  </Box>;
}
