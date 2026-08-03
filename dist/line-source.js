import readline from "node:readline";
import chalk from "chalk";
// --- Non-TTY fallback (piped input, CI, tests): buffered queue over Node's
// readline so synchronous multi-line bursts are never dropped and nested
// prompts (e.g. tool confirmations) never race a second listener. No paste
// shortening here — bracketed paste is a real-terminal feature only.
class BufferedLineSource {
    queue = [];
    waiting = null;
    closed = false;
    rl;
    constructor() {
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        this.rl.on("line", (line) => {
            if (this.waiting) {
                const resolve = this.waiting;
                this.waiting = null;
                resolve(line);
            }
            else {
                this.queue.push(line);
            }
        });
        this.rl.on("close", () => {
            this.closed = true;
            if (this.waiting) {
                const resolve = this.waiting;
                this.waiting = null;
                resolve(null);
            }
        });
    }
    async next(promptText) {
        process.stdout.write(promptText);
        if (this.queue.length > 0)
            return this.queue.shift();
        if (this.closed)
            return null;
        return new Promise((resolve) => {
            this.waiting = resolve;
        });
    }
    isClosed() {
        return this.closed;
    }
    isExhausted() {
        return this.closed && this.queue.length === 0;
    }
    close() {
        this.rl.close();
    }
}
class TtyLineSource {
    closed = false;
    pasteCounter = 0;
    cells = [];
    mode = "normal";
    csiBuf = "";
    pasteBuf = "";
    promptText = "";
    resolveCurrent = null;
    cleanedUp = false;
    constructor() {
        process.stdin.setEncoding("utf8");
        if (process.stdin.isTTY)
            process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdout.write("\x1b[?2004h"); // enable bracketed paste
        process.stdin.on("data", this.onData);
        process.on("exit", this.cleanup);
    }
    cleanup = () => {
        if (this.cleanedUp)
            return;
        this.cleanedUp = true;
        try {
            process.stdout.write("\x1b[?2004l");
            if (process.stdin.isTTY)
                process.stdin.setRawMode(false);
        }
        catch {
            // best-effort terminal restore
        }
    };
    isClosed() {
        return this.closed;
    }
    isExhausted() {
        return this.closed;
    }
    close() {
        this.closed = true;
        this.cleanup();
        process.stdin.removeListener("data", this.onData);
    }
    next(promptText) {
        this.promptText = promptText;
        this.cells = [];
        this.mode = "normal";
        this.csiBuf = "";
        this.pasteBuf = "";
        process.stdout.write(promptText);
        return new Promise((resolve) => {
            this.resolveCurrent = resolve;
        });
    }
    redraw() {
        process.stdout.write(`\r\x1b[K${this.promptText}`);
        for (const cell of this.cells) {
            if ("text" in cell)
                process.stdout.write(cell.text);
            else
                process.stdout.write(chalk.cyan(cell.label));
        }
    }
    submit() {
        const full = this.cells.map((c) => ("text" in c ? c.text : c.full)).join("");
        process.stdout.write("\r\n");
        const resolve = this.resolveCurrent;
        this.resolveCurrent = null;
        if (resolve)
            resolve(full);
    }
    backspace() {
        const last = this.cells.pop();
        if (!last)
            return;
        const width = "text" in last ? last.text.length : last.label.length;
        process.stdout.write(`\x1b[${width}D\x1b[K`);
    }
    onData = (chunk) => {
        for (const ch of chunk)
            this.handleChar(ch);
    };
    handleChar(ch) {
        if (!this.resolveCurrent)
            return; // no active prompt — drop keystrokes typed while busy
        if (this.mode === "paste") {
            this.pasteBuf += ch;
            if (this.pasteBuf.endsWith("\x1b[201~")) {
                const content = this.pasteBuf.slice(0, -6);
                this.pasteCounter += 1;
                const lines = content.split("\n").length;
                const label = `[Pasted text #${this.pasteCounter} · ${lines} line${lines === 1 ? "" : "s"}]`;
                this.cells.push({ label, full: content });
                process.stdout.write(chalk.cyan(label));
                this.mode = "normal";
                this.pasteBuf = "";
            }
            return;
        }
        if (this.mode === "csi") {
            this.csiBuf += ch;
            if (this.csiBuf === "[200~") {
                this.mode = "paste";
                this.pasteBuf = "";
                this.csiBuf = "";
                return;
            }
            const code = ch.charCodeAt(0);
            if (code >= 0x40 && code <= 0x7e) {
                this.mode = "normal"; // end of an unsupported CSI sequence (arrows etc.) — swallow it
                this.csiBuf = "";
            }
            return;
        }
        if (this.mode === "esc") {
            if (ch === "[") {
                this.mode = "csi";
                this.csiBuf = "";
            }
            else {
                this.mode = "normal";
            }
            return;
        }
        switch (ch) {
            case "\x1b":
                this.mode = "esc";
                return;
            case "\r":
            case "\n":
                this.submit();
                return;
            case "\x7f":
            case "\b":
                this.backspace();
                return;
            case "\x03": // Ctrl+C
                if (this.cells.length === 0) {
                    process.stdout.write("^C\r\n");
                    this.close();
                    process.exit(130);
                }
                this.cells = [];
                this.redraw();
                return;
            case "\x04": // Ctrl+D on an empty line = EOF
                if (this.cells.length === 0) {
                    process.stdout.write("\r\n");
                    const resolve = this.resolveCurrent;
                    this.resolveCurrent = null;
                    this.closed = true;
                    if (resolve)
                        resolve(null);
                }
                return;
            case "\x15": // Ctrl+U — clear line
                this.cells = [];
                this.redraw();
                return;
            default:
                if (ch.charCodeAt(0) < 0x20)
                    return; // ignore other control chars
                this.cells.push({ text: ch });
                process.stdout.write(ch);
        }
    }
}
export function createLineSource() {
    if (process.stdin.isTTY && process.stdout.isTTY)
        return new TtyLineSource();
    return new BufferedLineSource();
}
