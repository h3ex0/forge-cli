import React from "react";
import path from "node:path";
import fs from "node:fs";
import fg from "fast-glob";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ForgeConfig, Profile } from "../config.js";
import { saveConfig } from "../config.js";
import type { ChatMessage } from "../providers/types.js";
import { AgentSession, type ApprovalRequest } from "../agent/session.js";
import type { AgentEvent, AgentUsage, ToolActivity } from "../agent/events.js";
import { createTools } from "../tools/index.js";
import { decidePermission } from "../security/policy.js";
import { fetchModels, type ModelInfo } from "../providers/models.js";
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

interface SelectItem { id: string; label: string; detail?: string }
interface ApprovalState { request: ApprovalRequest; resolve: (allowed: boolean) => void }

function systemMessages(config: ForgeConfig): ChatMessage[] {
  const instructions = loadProjectInstructions(config.permissions.workspaceRoot)
    .map((item) => `\n\n[${item.file}]\n${item.content}`).join("");
  return [{ role: "system", content: `You are Forge, a concise AI coding assistant. Work only inside the approved workspace. Use tools when useful.${instructions}` }];
}

function statusSymbol(status: ToolActivity["status"]): string {
  return status === "completed" ? "✓" : status === "failed" ? "×" : status === "denied" ? "!" : status === "running" ? "●" : "○";
}

function MessageBlock({ message, theme }: { message: ChatMessage; theme: ReturnType<typeof getTheme> }): React.ReactElement {
  const sanitized = sanitizeTerminalText(message.content);
  const safe = sanitized.length > 12_000 ? `…[earlier content clipped]\n${sanitized.slice(-12_000)}` : sanitized;
  const role = message.role === "user" ? "YOU" : "FORGE";
  const color = message.role === "user" ? theme.accent : theme.success;
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold color={color}>{role}</Text>
    {safe.split("\n").map((line, index) => {
      const code = /^\s{4}|^```/.test(line);
      const heading = /^#{1,6}\s/.test(line);
      return <Text key={index} color={code ? theme.code : theme.text} bold={heading} wrap="wrap">{line || " "}</Text>;
    })}
  </Box>;
}

function Overlay({ title, query, items, selected, theme, footer }: { title: string; query: string; items: SelectItem[]; selected: number; theme: ReturnType<typeof getTheme>; footer: string }): React.ReactElement {
  return <Box position="absolute" width="82%" minHeight={8} alignSelf="center" marginTop={2} flexDirection="column" borderStyle="double" borderColor={theme.focusBorder} paddingX={2} paddingY={1}>
    <Text bold color={theme.accent}>{title}</Text>
    <Text color={theme.text}>Search: {sanitizeTerminalText(query)}█</Text>
    <Text color={theme.muted}>{"─".repeat(54)}</Text>
    {items.slice(Math.max(0, selected - 6), Math.max(0, selected - 6) + 13).map((item, index) => {
      const absolute = Math.max(0, selected - 6) + index;
      return <Text key={item.id} color={absolute === selected ? theme.accent : theme.text} inverse={absolute === selected}>
        {absolute === selected ? " › " : "   "}{sanitizeTerminalText(item.label)}{item.detail ? `  ${sanitizeTerminalText(item.detail)}` : ""}
      </Text>;
    })}
    {!items.length && <Text color={theme.muted}>No items available.</Text>}
    <Text color={theme.muted}>{footer}</Text>
  </Box>;
}

function ApprovalModal({ state, theme }: { state: ApprovalState; theme: ReturnType<typeof getTheme> }): React.ReactElement {
  const args = summarizeToolArguments(state.request.activity.args);
  return <Box position="absolute" width="86%" alignSelf="center" marginTop={2} flexDirection="column" borderStyle="double" borderColor={theme.warning} paddingX={2} paddingY={1}>
    <Text bold color={theme.warning}>APPROVAL REQUIRED · {state.request.activity.risk.toUpperCase()}</Text>
    <Text bold>{state.request.activity.name}</Text>
    <Text color={theme.muted} wrap="truncate-end">{args}</Text>
    <Text color={theme.warning}>Y allow once · N/Esc deny · Enter denies safely</Text>
  </Box>;
}

/** Render Forge's responsive, keyboard-first full-screen terminal workspace. */
export function ForgeTui({ config }: { config: ForgeConfig }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = React.useState({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 30 });
  const [input, setInput] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [streamText, setStreamText] = React.useState("");
  const [revision, setRevision] = React.useState(0);
  const [notice, setNotice] = React.useState("Ready");
  const [activities, setActivities] = React.useState<ToolActivity[]>([]);
  const [approval, setApproval] = React.useState<ApprovalState | null>(null);
  const [overlay, setOverlay] = React.useState<TuiOverlay | null>(null);
  const [overlayQuery, setOverlayQuery] = React.useState("");
  const [overlayItems, setOverlayItems] = React.useState<SelectItem[]>([]);
  const [selected, setSelected] = React.useState(0);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [queuedPrompt, setQueuedPrompt] = React.useState("");
  const [usage, setUsage] = React.useState<AgentUsage>({ promptTokens: 0, completionTokens: 0 });
  const [subscriptionTokensUsed, setSubscriptionTokensUsed] = React.useState(() => {
    const entry = loadUsageLedger().profiles[config.activeProfile];
    return entry ? entry.promptTokens + entry.completionTokens : 0;
  });
  const [pricing, setPricing] = React.useState<ModelInfo | undefined>();
  const contextFilesRef = React.useRef(new Map<string, string>());
  const approvalRef = React.useRef<ApprovalState | null>(null);
  const queuedPromptRef = React.useRef("");
  const operationAbortRef = React.useRef<AbortController | null>(null);
  const messagesRef = React.useRef<ChatMessage[]>(systemMessages(config));
  const sessionRef = React.useRef<AgentSession | null>(null);
  const theme = getTheme(config.ui.theme);

  const requestApproval = React.useCallback((request: ApprovalRequest): Promise<boolean> => new Promise((resolve) => {
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
    if (!queued) return;
    queuedPromptRef.current = "";
    setQueuedPrompt("");
    setTimeout(() => { void session.send(queued); }, 0);
  }, [session]);

  React.useEffect(() => {
    const resize = () => setDimensions({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 30 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);

  React.useEffect(() => session.subscribe((event: AgentEvent) => {
    if (event.type === "turn.started") { setBusy(true); setStreamText(""); setNotice("Thinking…"); setRevision((value) => value + 1); }
    else if (event.type === "text.delta") setStreamText((value) => value + event.delta);
    else if (event.type === "message.completed") {
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
    else if (event.type === "turn.failed") { setBusy(false); setNotice(`Error: ${sanitizeTerminalText(event.error.message)}`); }
    else if (event.type === "turn.cancelled") { setBusy(false); setNotice("Cancelled"); }
    else if (event.type === "turn.completed") {
      setBusy(false); setNotice("Ready"); setRevision((value) => value + 1);
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

  const selectOverlayItem = React.useCallback(() => {
    const item = filteredOverlayItems[selected];
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

  const submit = React.useCallback(async () => {
    const value = input.trim();
    if (!value) return;
    setInput(""); setCursor(0); setScrollOffset(0);
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
    if (command.type === "exit") { exit(); return; }
    if (command.type === "overlay") { setOverlay(command.overlay); return; }
    if (command.type === "notice") { setNotice(command.message); setRevision((revision) => revision + 1); return; }
    if (command.type === "clear") { messagesRef.current.splice(0, messagesRef.current.length, ...systemMessages(config)); setActivities([]); setNotice("New conversation"); setRevision((revision) => revision + 1); return; }
    if (command.type === "load") { messagesRef.current.splice(0, messagesRef.current.length, ...command.messages); setNotice(`Loaded ${command.name}`); setRevision((revision) => revision + 1); return; }
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
    if (command.type === "tool") {
      const tool = createTools({ workspaceRoot: config.permissions.workspaceRoot }).find((item) => item.def.name === command.name);
      if (!tool) { setNotice(`Tool ${command.name} is unavailable.`); return; }
      const decision = decidePermission(config.permissions.mode, tool.risk);
      if (decision === "deny") { setNotice(`${config.permissions.mode} mode blocks ${tool.risk} tools.`); return; }
      if (decision === "ask") {
        const id = `command-${Date.now()}`;
        const allowed = await requestApproval({
          call: { id, name: tool.def.name, arguments: JSON.stringify(command.args) },
          activity: { id, name: tool.def.name, risk: tool.risk, status: "waiting", args: command.args, startedAt: Date.now() },
        });
        if (!allowed) { setNotice("Command denied."); return; }
      }
      const activity: ToolActivity = { id: `command-${Date.now()}`, name: tool.def.name, risk: tool.risk, status: "running", args: command.args, startedAt: Date.now() };
      setActivities((items) => [activity, ...items].slice(0, 20));
      setBusy(true);
      operationAbortRef.current = new AbortController();
      try {
        const result = await tool.execute(command.args, operationAbortRef.current.signal);
        activity.status = "completed"; activity.result = result; activity.durationMs = Date.now() - activity.startedAt;
        messagesRef.current.push({ role: "assistant", content: `Command output (${tool.def.name}):\n${result}` });
        setNotice(`${tool.def.name} completed.`);
      } catch (error) {
        activity.status = "failed"; activity.result = error instanceof Error ? error.message : String(error); activity.durationMs = Date.now() - activity.startedAt;
        setNotice(`${tool.def.name} failed: ${activity.result}`);
      } finally {
        setActivities((items) => [{ ...activity }, ...items.filter((item) => item.id !== activity.id)].slice(0, 20));
        operationAbortRef.current = null; setBusy(false); setRevision((revision) => revision + 1); flushQueuedPrompt();
      }
      return;
    }
    await session.send(command.type === "prompt" ? command.prompt : value);
  }, [busy, config, exit, flushQueuedPrompt, input, requestApproval, session]);

  useInput((character, key) => {
    if (approval) {
      if (character.toLowerCase() === "y") closeApproval(true);
      else if (character.toLowerCase() === "n" || key.escape || key.return) closeApproval(false);
      return;
    }
    if (key.ctrl && character === "c") { if (busy) { session.cancel(); operationAbortRef.current?.abort(); } else exit(); return; }
    if (key.escape) { if (overlay) setOverlay(null); else if (busy) { session.cancel(); operationAbortRef.current?.abort(); } return; }
    if (key.ctrl && character === "k") { setOverlay("commands"); return; }
    if (key.ctrl && character === "m") { setOverlay("models"); return; }
    if (key.ctrl && character === "p") { setOverlay("context"); return; }
    if (key.ctrl && character === "s") { setOverlay("sessions"); return; }
    if (overlay) {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setSelected((value) => Math.max(0, Math.min(filteredOverlayItems.length - 1, value + 1)));
      else if (key.return) selectOverlayItem();
      else if (key.backspace || key.delete) { setOverlayQuery((value) => value.slice(0, -1)); setSelected(0); }
      else if (!key.ctrl && !key.meta && character) { setOverlayQuery((value) => value + character); setSelected(0); }
      return;
    }
    if (character === "?" && !input) { setOverlay("help"); return; }
    if (key.pageUp) { setScrollOffset((value) => value + 5); return; }
    if (key.pageDown) { setScrollOffset((value) => Math.max(0, value - 5)); return; }
    if (key.ctrl && character === "j") { setInput((value) => value.slice(0, cursor) + "\n" + value.slice(cursor)); setCursor((value) => value + 1); return; }
    if (key.return) { void submit(); return; }
    if (key.leftArrow) { setCursor((value) => Math.max(0, value - 1)); return; }
    if (key.rightArrow) { setCursor((value) => Math.min(input.length, value + 1)); return; }
    if (key.backspace || key.delete) {
      if (cursor > 0) { setInput((value) => value.slice(0, cursor - 1) + value.slice(cursor)); setCursor((value) => value - 1); }
      return;
    }
    if (!key.ctrl && !key.meta && character) {
      setInput((value) => value.slice(0, cursor) + character + value.slice(cursor));
      setCursor((value) => value + character.length);
    }
  });

  const profile = config.profiles[config.activeProfile];
  const allMessages = messagesRef.current.filter((message) => message.role === "user" || message.role === "assistant");
  const displayMessages = streamText ? [...allMessages, { role: "assistant" as const, content: streamText }] : allMessages;
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

  return <Box flexDirection="column" height={dimensions.rows} width={dimensions.columns}>
    <Box borderStyle="round" borderColor={theme.focusBorder} paddingX={1} justifyContent="space-between">
      <Text bold color={theme.accent}>◆ FORGE</Text>
      <Text wrap="truncate-end">{sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))} · {sanitizeTerminalText(config.activeProfile)}/{sanitizeTerminalText(profile.model)} · {profile.kind === "local" ? "● local" : "◉ cloud"} · {config.permissions.mode}{config.routing.offline ? " · offline" : ""}</Text>
    </Box>

    <Box flexGrow={1}>
      {wide && <Box width={25} flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
        <Text bold color={theme.accent}>ACTIVITY</Text>
        {activities.slice(0, Math.max(3, dimensions.rows - 10)).map((item) => <Text key={item.id} color={item.status === "failed" ? theme.danger : item.status === "completed" ? theme.success : theme.warning} wrap="truncate-end">
          {statusSymbol(item.status)} {sanitizeTerminalText(item.name)} {item.durationMs != null ? `${item.durationMs}ms` : ""}
        </Text>)}
        {!activities.length && <Text color={theme.muted}>Tool calls appear here.</Text>}
      </Box>}

      <Box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={theme.focusBorder} paddingX={1}>
        {visibleMessages.map((message, index) => <MessageBlock key={`${message.role}-${index}-${message.content.length}`} message={message} theme={theme} />)}
        {!visibleMessages.length && <Box flexGrow={1} alignItems="center" justifyContent="center"><Text color={theme.muted}>Ask about this workspace, press Ctrl+K for commands, or Ctrl+M for models.</Text></Box>}
      </Box>

      {medium && <Box width={wide ? 29 : 25} flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
        <Text bold color={theme.accent}>CONTEXT</Text>
        <Text wrap="truncate-end">Workspace: {sanitizeTerminalText(path.basename(config.permissions.workspaceRoot))}</Text>
        <Text>Instructions: {loadProjectInstructions(config.permissions.workspaceRoot).length}</Text>
        <Text>Pinned files: {contextFilesRef.current.size}</Text>
        <Text>Messages: {allMessages.length}</Text>
        <Text>Context: ~{estimateMessageTokens(messagesRef.current).toLocaleString("en-US")} tokens</Text>
        <Text color={theme.muted}>Ctrl+P add files</Text>
        <Box marginTop={1} flexDirection="column"><Text bold color={theme.accent}>SESSION</Text><Text>{busy ? "● Working" : "○ Ready"}</Text><Text wrap="wrap" color={theme.muted}>{sanitizeTerminalText(notice)}</Text></Box>
      </Box>}
    </Box>

    <Box borderStyle="round" borderColor={busy ? theme.warning : theme.focusBorder} paddingX={1} minHeight={3}>
      <Text color={busy ? theme.warning : theme.text} wrap="wrap">{sanitizeTerminalText(busy ? `Working… type to queue · Esc cancel${input ? `\n› ${cursorView}` : ""}` : `› ${cursorView}`)}</Text>
    </Box>
    {suggestions.length > 0 && !overlay && <Text color={theme.muted}> {suggestions.join("  ")}</Text>}
    <Box paddingX={1} justifyContent="space-between">
      <Text color={limitExceeded ? theme.danger : theme.muted} bold={limitExceeded} wrap="truncate-end">{sanitizeTerminalText(usageLine)}</Text>
    </Box>
    {queuedPrompt && <Text color={theme.warning} wrap="truncate-end"> Queued: {sanitizeTerminalText(queuedPrompt)}</Text>}
    <Text color={theme.muted}> Ctrl+K commands · Ctrl+P files · Ctrl+M models · Ctrl+S sessions · PgUp/PgDn scroll · Ctrl+J newline · ? help</Text>

    {overlay && <Overlay title={overlay.toUpperCase()} query={overlayQuery} items={filteredOverlayItems} selected={selected} theme={theme} footer="Type to filter · ↑/↓ select · Enter choose · Esc close" />}
    {approval && <ApprovalModal state={approval} theme={theme} />}
  </Box>;
}
