import { emitKeypressEvents, createInterface } from "node:readline";

/**
 * Tiny zero-dependency TUI toolkit: text prompts, y/n confirms, arrow-key
 * single-select with action keys, and checkbox multi-select. Used only when
 * stdin+stdout are TTYs — every command keeps a flag-based path for scripts.
 */

export function isInteractive(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K\r";

function write(s: string): void {
  process.stdout.write(s);
}

function moveUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : "";
}

interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

/** Run a raw-keypress loop until the handler resolves a value. */
function withKeys<T>(handler: (key: Key, done: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      write(SHOW_CURSOR);
    };

    const onKeypress = (_str: string | undefined, key: Key | undefined) => {
      const k = key ?? {};
      if (k.ctrl && k.name === "c") {
        cleanup();
        write("\n");
        process.exit(130);
      }
      handler(k, (value) => {
        cleanup();
        resolve(value);
      });
    };

    process.stdin.on("keypress", onKeypress);
  });
}

export interface SelectItem {
  label: string;
  hint?: string;
}

export interface SelectResult {
  index: number;
  key: string; // "return" or one of opts.keys
}

/**
 * Arrow-key list picker. Returns the highlighted index plus the key that
 * confirmed it ("return" or a registered action key), or null on q/esc.
 */
export async function selectList(
  title: string,
  items: SelectItem[],
  opts: { footer: string; keys?: string[] }
): Promise<SelectResult | null> {
  if (items.length === 0) return null;
  let cursor = 0;
  let drawn = 0;

  const render = () => {
    const lines: string[] = [c.bold(title)];
    items.forEach((item, i) => {
      const hint = item.hint ? c.dim(item.hint) : "";
      lines.push(i === cursor ? `${c.cyan("❯")} ${c.cyan(item.label)}${hint}` : `  ${item.label}${hint}`);
    });
    lines.push(c.dim(opts.footer));
    write(moveUp(drawn));
    for (const line of lines) write(CLEAR_LINE + line + "\n");
    drawn = lines.length;
  };

  write(HIDE_CURSOR);
  render();

  return withKeys<SelectResult | null>((key, done) => {
    switch (key.name) {
      case "up":
      case "k":
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      case "down":
      case "j":
        cursor = (cursor + 1) % items.length;
        render();
        return;
      case "return":
        done({ index: cursor, key: "return" });
        return;
      case "escape":
      case "q":
        done(null);
        return;
      default:
        if (key.name && opts.keys?.includes(key.name)) {
          done({ index: cursor, key: key.name });
        }
    }
  });
}

/**
 * Checkbox picker: space toggles, enter saves, q/esc cancels (returns null).
 * Returns the selected indexes.
 */
export async function multiSelect(
  title: string,
  items: SelectItem[],
  preChecked: number[],
  footer = "↑↓ move · space toggle · enter save · q cancel"
): Promise<number[] | null> {
  if (items.length === 0) return [];
  let cursor = 0;
  let drawn = 0;
  const checked = new Set<number>(preChecked);

  const render = () => {
    const lines: string[] = [c.bold(title)];
    items.forEach((item, i) => {
      const box = checked.has(i) ? c.green("◉") : "◯";
      const hint = item.hint ? c.dim(item.hint) : "";
      const row = `${box} ${item.label}${hint}`;
      lines.push(i === cursor ? `${c.cyan("❯")} ${row}` : `  ${row}`);
    });
    lines.push(c.dim(footer));
    write(moveUp(drawn));
    for (const line of lines) write(CLEAR_LINE + line + "\n");
    drawn = lines.length;
  };

  write(HIDE_CURSOR);
  render();

  return withKeys<number[] | null>((key, done) => {
    switch (key.name) {
      case "up":
      case "k":
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      case "down":
      case "j":
        cursor = (cursor + 1) % items.length;
        render();
        return;
      case "space":
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        render();
        return;
      case "return":
        done([...checked].sort((a, b) => a - b));
        return;
      case "escape":
      case "q":
        done(null);
        return;
    }
  });
}

/** Plain text prompt with an optional default. */
export function ask(question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? ` ${c.dim(`(${def})`)}` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def || "");
    });
  });
}

export async function confirm(question: string, def = true): Promise<boolean> {
  const answer = await ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`);
  if (!answer) return def;
  return /^y/i.test(answer);
}

export function ageString(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
