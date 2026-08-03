export interface MouseEvent {
  button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "other";
  action: "press" | "release" | "wheel";
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface Rectangle { x: number; y: number; width: number; height: number }

/** Parse an SGR (1006) terminal mouse report. Coordinates are normalized to zero-based cells. */
export function parseMouseInput(input: string): MouseEvent | undefined {
  const match = input.match(/^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!match) return undefined;
  const code = Number(match[1]);
  const base = code & 0b11;
  const wheel = (code & 64) !== 0;
  const button = wheel
    ? (base === 0 ? "wheel-up" : base === 1 ? "wheel-down" : "other")
    : base === 0 ? "left" : base === 1 ? "middle" : base === 2 ? "right" : "other";
  return {
    button,
    action: wheel ? "wheel" : match[4] === "M" ? "press" : "release",
    x: Math.max(0, Number(match[2]) - 1),
    y: Math.max(0, Number(match[3]) - 1),
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

export function containsPoint(rectangle: Rectangle | undefined, x: number, y: number): boolean {
  return Boolean(rectangle && rectangle.width > 0 && rectangle.height > 0
    && x >= rectangle.x && x < rectangle.x + rectangle.width
    && y >= rectangle.y && y < rectangle.y + rectangle.height);
}

export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";
