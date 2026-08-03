import { createDriver } from "./providers/index.js";
export async function startTui(config) {
    const React = await import("react");
    const { Box, Text, render, useApp, useInput } = await import("ink");
    function ForgeTui() {
        const { exit } = useApp();
        const profile = config.profiles[config.activeProfile];
        const [input, setInput] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [messages, setMessages] = React.useState([
            { role: "system", content: "You are Forge, a concise AI coding assistant." },
        ]);
        const visible = messages.filter((message) => message.role !== "system").slice(-10);
        const send = React.useCallback(async () => {
            const prompt = input.trim();
            if (!prompt || busy || !profile)
                return;
            if (prompt === "/exit" || prompt === "/quit") {
                exit();
                return;
            }
            setInput("");
            setBusy(true);
            const next = [...messages, { role: "user", content: prompt }];
            setMessages([...next, { role: "assistant", content: "" }]);
            let assistant = "";
            let failure;
            await createDriver(profile).streamChat(next, [], profile.model, {
                onTextDelta(delta) {
                    assistant += delta;
                    setMessages([...next, { role: "assistant", content: assistant }]);
                },
                onToolCallsComplete() { },
                onDone() { },
                onError(error) { failure = error; },
            });
            if (failure)
                setMessages([...next, { role: "assistant", content: `Error: ${failure.message}` }]);
            else
                setMessages([...next, { role: "assistant", content: assistant }]);
            setBusy(false);
        }, [busy, exit, input, messages, profile]);
        useInput((character, key) => {
            if (key.ctrl && character === "c") {
                exit();
                return;
            }
            if (busy)
                return;
            if (key.return) {
                void send();
                return;
            }
            if (key.backspace || key.delete) {
                setInput((value) => value.slice(0, -1));
                return;
            }
            if (!key.ctrl && !key.meta && character)
                setInput((value) => value + character);
        });
        return React.createElement(Box, { flexDirection: "column", height: "100%" }, React.createElement(Box, { borderStyle: "round", borderColor: "magenta", paddingX: 1, justifyContent: "space-between" }, React.createElement(Text, { bold: true, color: "magenta" }, "🔥 FORGE"), React.createElement(Text, null, `${config.activeProfile} · ${profile?.model ?? "not configured"} · ${config.permissions.mode}`)), React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1 }, ...visible.map((message, index) => React.createElement(Box, { key: `${message.role}-${index}`, marginBottom: 1, flexDirection: "column" }, React.createElement(Text, { bold: true, color: message.role === "user" ? "cyan" : "green" }, message.role === "user" ? "You" : "Forge"), React.createElement(Text, null, message.content || (busy && index === visible.length - 1 ? "Thinking…" : ""))))), React.createElement(Box, { borderStyle: "single", borderColor: busy ? "yellow" : "blue", paddingX: 1 }, React.createElement(Text, { color: "cyan" }, busy ? "Working…" : `› ${input}█`)), React.createElement(Text, { dimColor: true }, ` ${config.permissions.workspaceRoot} · Enter send · Ctrl+C exit · use inline REPL for slash commands`));
    }
    const instance = render(React.createElement(ForgeTui));
    await instance.waitUntilExit();
}
