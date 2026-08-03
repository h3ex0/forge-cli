import readline from "node:readline";
import chalk from "chalk";

export interface LineSource {
  next(promptText: string): Promise<string | null>;
  isClosed(): boolean;
  isExhausted(): boolean;
  close(): void;
}

// --- Non-TTY fallback (piped input, CI, tests): buffered queue over Node's
// readline so synchronous multi-line bursts are never dropped and nested
// prompts (e.g. tool confirmations) never race a second listener. No paste
// shortening here — bracketed paste is a real-terminal feature only.
class BufferedLineSource implements LineSource {
  private queue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    this.rl.on("line", (line: string) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line);
      } else {
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

  async next(promptText: string): Promise<string | null> {
    process.stdout.write(promptText);
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return null;
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

// --- Interactive TTY reader: owns raw stdin directly (bypassing Node's
// readline) so it can intercept bracketed-paste sequences before the terminal's
// own local echo dumps the whole pasted blob onto the screen. Pasted content is
// shown as a short "[Pasted text #N · M lines]" placeholder and swapped back to
// the full text only when the line is submitted. Editing is intentionally
// append/backspace-only (no mid-line cursor movement) to keep the ANSI handling
// simple and safe — arrow keys are silently swallowed rather than corrupting
// the line.
type Mode = "normal" | "esc" | "csi" | "paste";

class TtyLineSource implements LineSource {
  private closed = false;
  private pasteCounter = 0;
  private cells: Array<{ text: string } | { label: string; full: string }> = [];
  private mode: Mode = "normal";
  private csiBuf = "";
  private pasteBuf = "";
  private promptText = "";
  private resolveCurrent: ((line: string | null) => void) | null = null;
  private cleanedUp = false;

  constructor() {
    process.stdin.setEncoding("utf8");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?2004h"); // enable bracketed paste
    process.stdin.on("data", this.onData);
    process.on("exit", this.cleanup);
  }

  private cleanup = () => {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    try {
      process.stdout.write("\x1b[?2004l");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
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

  next(promptText: string): Promise<string | null> {
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

  private redraw() {
    process.stdout.write(`\r\x1b[K${this.promptText}`);
    for (const cell of this.cells) {
      if ("text" in cell) process.stdout.write(cell.text);
      else process.stdout.write(chalk.cyan(cell.label));
    }
  }

  private submit() {
    const full = this.cells.map((c) => ("text" in c ? c.text : c.full)).join("");
    process.stdout.write("\r\n");
    const resolve = this.resolveCurrent;
    this.resolveCurrent = null;
    if (resolve) resolve(full);
  }

  private backspace() {
    const last = this.cells.pop();
    if (!last) return;
    const width = "text" in last ? last.text.length : last.label.length;
    process.stdout.write(`\x1b[${width}D\x1b[K`);
  }

  private onData = (chunk: string) => {
    for (const ch of chunk) this.handleChar(ch);
  };

  private handleChar(ch: string) {
    if (!this.resolveCurrent) return; // no active prompt — drop keystrokes typed while busy

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
      } else {
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
          if (resolve) resolve(null);
        }
        return;
      case "\x15": // Ctrl+U — clear line
        this.cells = [];
        this.redraw();
        return;
      default:
        if (ch.charCodeAt(0) < 0x20) return; // ignore other control chars
        this.cells.push({ text: ch });
        process.stdout.write(ch);
    }
  }
}

export function createLineSource(): LineSource {
  if (process.stdin.isTTY && process.stdout.isTTY) return new TtyLineSource();
  return new BufferedLineSource();
}
