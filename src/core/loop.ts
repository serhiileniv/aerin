import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config/paths.js";
import { runEvery } from "../tools/schedule-tool.js";

/**
 * `/loop <when> <prompt>` — run a prompt on a schedule, outside this session.
 *
 * Each firing is a fresh headless run (`aerin -p --output-format text
 * --prompt-file <file>`) scheduled through `every`, so it survives the
 * session ending, has a run history (`/loop log`), and never touches cron.
 * The prompt lives in a file under the data dir: no shell quoting of user
 * text on any platform, and multi-line prompts just work.
 */

export const LOOP_USAGE = [
  "usage:",
  "  /loop <when> <prompt>        schedule a headless run: /loop 15m check CI and report failures",
  "  /loop <when> -- <prompt>     explicit separator when the prompt starts with a time-looking word",
  "  /loop                        list loops",
  "  /loop log <name> [n]         output of recent runs",
  "  /loop run <name>             run it now",
  "  /loop stop <name>            remove it (logs are kept)",
  "options (before the prompt): --name <n>, --timeout <t> (default 10m), --yolo (auto-approve tools)",
  "when: 90s · 15m · 2h · hourly · day 9am · day 9am,6pm · weekdays 9:30 · monday,thursday 6pm · monthly 1st 9am",
  "      once 15:30 · once tomorrow 9am · once friday 5pm · once 2026-12-24 18:00 · once 45m (runs once, then removes itself)",
].join("\n");

export type LoopRequest =
  | { kind: "list" }
  | { kind: "log"; name: string; lines?: number }
  | { kind: "run"; name: string }
  | { kind: "stop"; name: string }
  | { kind: "add"; when: string; prompt: string; name?: string; timeout: string; yolo: boolean };

export const DEFAULT_LOOP_TIMEOUT = "10m";

const DURATION = /^\d+(s|m|h|d)$/i;
const DAY = "(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)";
const DAYS = new RegExp(`^${DAY}(,${DAY})*$`, "i");
const TIME = /^\d{1,2}(:\d{2})?(am|pm)?(,\d{1,2}(:\d{2})?(am|pm)?)*$/i;
const AMPM = /^(am|pm)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ORDINAL = /^\d{1,2}(st|nd|rd|th)?(,\d{1,2}(st|nd|rd|th)?)*$/i;
const RELATIVE = /^(today|tomorrow)$/i;
const SIMPLE_HEADS = new Set(["hourly", "daily", "weekly"]);
const TIMED_HEADS = new Set(["day", "weekdays", "weekends"]);

/**
 * Split `every`'s schedule phrase off the front of a token list. Grammar-
 * driven per head word so a prompt that starts with a number ("3 times…")
 * after a bare duration is never swallowed. Returns the number of tokens
 * consumed, or 0 if the tokens don't start with a schedule.
 */
export function scheduleLength(tokens: readonly string[]): number {
  const head = (tokens[0] ?? "").toLowerCase();
  if (!head) return 0;
  const at = (i: number) => tokens[i] ?? "";
  let i = 1;
  const takeTime = () => {
    if (TIME.test(at(i))) {
      i++;
      if (AMPM.test(at(i))) i++;
    }
  };
  if (DURATION.test(head) || SIMPLE_HEADS.has(head)) return 1;
  if (head === "monthly") {
    if (ORDINAL.test(at(i))) i++;
    takeTime();
    return i;
  }
  if (TIMED_HEADS.has(head) || DAYS.test(head)) {
    takeTime();
    return i;
  }
  if (head === "once") {
    if (DURATION.test(at(i))) return i + 1;
    if (RELATIVE.test(at(i)) || DAYS.test(at(i)) || DATE.test(at(i))) i++;
    takeTime();
    return i;
  }
  return 0;
}

/** Parse the text after `/loop`. Throws a usage error on bad input. */
export function parseLoopArgs(arg: string): LoopRequest {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const [first, second] = tokens;
  if (!first) return { kind: "list" };
  if (first === "list" || first === "ls") return { kind: "list" };
  if (first === "log" || first === "run" || first === "stop" || first === "rm" || first === "remove") {
    if (!second) throw new Error(`/loop ${first} needs a loop name — /loop lists them.`);
    if (first === "log") {
      const n = tokens[2] !== undefined ? Number(tokens[2]) : undefined;
      return { kind: "log", name: second, ...(n !== undefined && Number.isFinite(n) && n > 0 ? { lines: Math.floor(n) } : {}) };
    }
    return { kind: first === "run" ? "run" : "stop", name: second };
  }

  const opts: { name?: string; timeout?: string; yolo: boolean } = { yolo: false };
  let i = 0;
  const takeOptions = () => {
    for (;;) {
      const t = tokens[i];
      if (t === "--yolo") {
        opts.yolo = true;
        i++;
      } else if (t === "--name" || t === "--timeout") {
        const v = tokens[i + 1];
        if (!v || v.startsWith("--")) throw new Error(`${t} needs a value.\n${LOOP_USAGE}`);
        if (t === "--name") opts.name = v;
        else opts.timeout = v;
        i += 2;
      } else return;
    }
  };

  takeOptions();
  const rest = tokens.slice(i);
  const sep = rest.indexOf("--");
  let when: string;
  let promptTokens: string[];
  if (sep >= 0) {
    when = rest.slice(0, sep).join(" ");
    promptTokens = rest.slice(sep + 1);
  } else {
    const n = scheduleLength(rest);
    if (n === 0) {
      throw new Error(
        `"${rest[0] ?? ""}" is not a schedule. Start with when to run, e.g. /loop 15m <prompt>.\n${LOOP_USAGE}`,
      );
    }
    when = rest.slice(0, n).join(" ");
    i += n;
    takeOptions();
    promptTokens = tokens.slice(i);
  }
  if (!when) throw new Error(`/loop needs a schedule before "--".\n${LOOP_USAGE}`);
  const prompt = promptTokens.join(" ").trim();
  if (!prompt) throw new Error(`/loop ${when} needs a prompt to run.\n${LOOP_USAGE}`);
  return {
    kind: "add",
    when,
    prompt,
    timeout: opts.timeout ?? DEFAULT_LOOP_TIMEOUT,
    yolo: opts.yolo,
    ...(opts.name ? { name: opts.name } : {}),
  };
}

/** `loop-` + the first words of the prompt, kebab-cased, short enough for a task list. */
export function loopNameFor(prompt: string): string {
  const words = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 24) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, 24);
  return slug ? `loop-${slug}` : "loop";
}

/** Quote one argv element for the platform shell `every` runs commands through. */
export function shellQuote(s: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  if (platform === "win32") return `"${s.replace(/"/g, '""')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface AerinInvocation {
  execPath: string;
  argv1: string;
  pathDirs: readonly string[];
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}

/**
 * How a scheduled task should start aerin. Prefer the bare `aerin` when the
 * login shell will find it on PATH (readable in `every list`); otherwise pin
 * the runtime + entry that is running right now (dev checkouts, npx caches,
 * GUI launches with a thin PATH).
 */
export function resolveAerinInvocation(i: AerinInvocation): string[] {
  const base = path.basename(i.argv1);
  if (base !== "index.ts") {
    const names = i.platform === "win32" ? ["aerin.cmd", "aerin.exe", "aerin"] : ["aerin"];
    if (i.pathDirs.some((d) => d && names.some((n) => i.exists(path.join(d, n))))) return ["aerin"];
  }
  return [i.execPath, i.argv1];
}

export function aerinInvocation(): string[] {
  return resolveAerinInvocation({
    execPath: process.execPath,
    argv1: process.argv[1] ?? "",
    pathDirs: (process.env["PATH"] ?? "").split(path.delimiter),
    platform: process.platform,
    exists: (p) => fs.existsSync(p),
  });
}

export const LOOP_PROMPT_FLAG = "--prompt-file";

export interface LoopCommandParts {
  aerin: readonly string[];
  promptFile: string;
  yolo: boolean;
  model?: string;
  platform?: NodeJS.Platform;
}

/** The one-line shell command `every` runs. */
export function buildLoopCommand(p: LoopCommandParts): string {
  const q = (s: string) => shellQuote(s, p.platform);
  const parts = [...p.aerin.map(q), "-p", "--output-format", "text", LOOP_PROMPT_FLAG, q(p.promptFile)];
  if (p.yolo) parts.push("--yolo");
  if (p.model) parts.push("-m", q(p.model));
  return parts.join(" ");
}

export function loopsDir(): string {
  return path.join(DATA_DIR, "loops");
}

interface EveryTask {
  name: string;
  schedule: string;
  command: string;
  status: string;
  paused: boolean;
  last?: { at: string; exit: number } | null;
  next?: string | null;
}

export interface LoopCtx {
  cwd: string;
  /** The session runs with --yolo; loops inherit it. */
  yolo: boolean;
  modelId?: string;
  /** Override for tests. */
  loopsDir?: string;
  aerin?: readonly string[];
}

async function listTasks(cwd: string): Promise<EveryTask[]> {
  const res = await runEvery(["list", "--json"], { cwd });
  if (res.code !== 0) throw new Error(res.output || `every list failed (exit ${res.code})`);
  const start = res.output.indexOf("[");
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(res.output.slice(start)) as unknown;
    return Array.isArray(parsed) ? (parsed as EveryTask[]) : [];
  } catch {
    throw new Error(`could not read every's task list: ${res.output.slice(0, 200)}`);
  }
}

function isLoop(t: EveryTask): boolean {
  return t.command.includes(LOOP_PROMPT_FLAG);
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function promptPreview(dir: string, name: string): Promise<string> {
  try {
    const text = (await fsp.readFile(path.join(dir, `${name}.md`), "utf8")).trim().replace(/\s+/g, " ");
    return text.length > 70 ? `${text.slice(0, 69)}…` : text;
  } catch {
    return "";
  }
}

/** Run a `/loop` request. Returns the text the frontend prints. */
export async function loopCommand(ctx: LoopCtx, arg: string): Promise<string> {
  const req = parseLoopArgs(arg);
  const dir = ctx.loopsDir ?? loopsDir();

  switch (req.kind) {
    case "list": {
      const loops = (await listTasks(ctx.cwd)).filter(isLoop);
      if (loops.length === 0) return "(no loops — /loop <when> <prompt> schedules one, e.g. /loop 15m check CI)";
      const pad = Math.max(...loops.map((l) => l.name.length)) + 2;
      const rows: string[] = [];
      for (const l of loops) {
        const state = l.paused ? "paused" : l.status;
        const last = l.last ? `last ${when(l.last.at)}${l.last.exit === 0 ? "" : ` (exit ${l.last.exit})`}` : "never ran";
        rows.push(`  ${l.name.padEnd(pad)}${l.schedule.padEnd(16)}${state.padEnd(8)}${last} · next ${when(l.next)}`);
        const preview = await promptPreview(dir, l.name);
        if (preview) rows.push(`  ${"".padEnd(pad)}${preview}`);
      }
      return `Loops (via every):\n${rows.join("\n")}\n  /loop log <name> · /loop run <name> · /loop stop <name>`;
    }
    case "log": {
      const args = ["log", req.name];
      if (req.lines) args.push("-n", String(req.lines));
      const res = await runEvery(args, { cwd: ctx.cwd });
      if (res.code === 66) return `no loop "${req.name}" (or it has not run yet) — /loop lists them`;
      return res.output || (res.code === 0 ? "(no runs logged yet)" : `every log failed (exit ${res.code})`);
    }
    case "run": {
      const res = await runEvery(["run", req.name], { cwd: ctx.cwd, timeoutMs: 15 * 60_000 });
      if (res.code === 66) return `no loop "${req.name}" — /loop lists them`;
      return `${res.output}${res.code === 0 ? "" : `\n[exit code ${res.code}]`}`;
    }
    case "stop": {
      const res = await runEvery(["rm", req.name], { cwd: ctx.cwd });
      if (res.code === 66) return `no loop "${req.name}" — /loop lists them`;
      if (res.code !== 0) return `${res.output}\n[every rm failed with exit code ${res.code}]`;
      await fsp.rm(path.join(dir, `${req.name}.md`), { force: true }).catch(() => {});
      return `stopped ${req.name} (run history kept: every log ${req.name})`;
    }
    case "add": {
      let name = req.name;
      if (!name) {
        // Auto-names must not clobber an existing task with the same opening words.
        const taken = new Set((await listTasks(ctx.cwd)).map((t) => t.name));
        const base = loopNameFor(req.prompt);
        name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      }
      await fsp.mkdir(dir, { recursive: true });
      const promptFile = path.join(dir, `${name}.md`);
      await fsp.writeFile(promptFile, `${req.prompt}\n`, "utf8");
      const command = buildLoopCommand({
        aerin: ctx.aerin ?? aerinInvocation(),
        promptFile,
        yolo: req.yolo || ctx.yolo,
        ...(ctx.modelId ? { model: ctx.modelId } : {}),
      });
      const res = await runEvery(["set", req.when, "--name", name, "--timeout", req.timeout, "--", command], { cwd: ctx.cwd });
      if (res.code !== 0) {
        await fsp.rm(promptFile, { force: true }).catch(() => {});
        return `${res.output}\n(every rejected the loop — check the schedule phrase; ${LOOP_USAGE.split("\n").slice(-2).join(" ")})`;
      }
      const auto = req.yolo || ctx.yolo;
      return [
        `loop ${name}: every ${req.when} → aerin -p ${auto ? "--yolo " : ""}"${req.prompt.length > 60 ? `${req.prompt.slice(0, 59)}…` : req.prompt}"`,
        `  runs from ${ctx.cwd}, timeout ${req.timeout}, ${auto ? "tools auto-approved (--yolo)" : "tools limited to read-tier and allow rules (add --yolo to let it edit/run)"}`,
        `  each firing is a fresh session with no memory of the last — pass state through files or the prompt`,
        `  /loop log ${name} · /loop run ${name} · /loop stop ${name}`,
        ...(res.output ? [`  ${res.output.split("\n")[0]}`] : []),
      ].join("\n");
    }
  }
}
