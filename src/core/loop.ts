import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config/paths.js";
import { runEvery } from "../tools/schedule-tool.js";

/**
 * `/loop <when> <prompt>` — run a prompt on a schedule, outside this session.
 * Each firing is a fresh headless run (`aerin -p --output-format text
 * --prompt-file <file>`) registered with `every`, so it survives the session,
 * has a run history, and never touches cron. The prompt lives in a file: no
 * shell quoting of user text on any platform, multi-line prompts just work.
 */

export const LOOP_USAGE = `usage: /loop <when> [--name n] [--timeout 10m] [--yolo] <prompt>   (or: /loop <when> -- <prompt>)
       /loop · /loop log <name> [n] · /loop run <name> · /loop stop <name>
when:  90s · 15m · 2h · hourly · day 9am · day 9am,6pm · weekdays 9:30 · monday,thursday 6pm · monthly 1st 9am
       once 15:30 · once tomorrow 9am · once friday 5pm · once 2026-12-24 18:00 · once 45m (fires once, then removes itself)`;

export type LoopRequest =
  | { kind: "list" }
  | { kind: "log"; name: string; lines?: number }
  | { kind: "run" | "stop"; name: string }
  | { kind: "add"; when: string; prompt: string; name?: string; timeout: string; yolo: boolean };

export const DEFAULT_LOOP_TIMEOUT = "10m";
const DURATION = /^\d+[smhd]$/i;
const DAY = "(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)";
const DAYS = new RegExp(`^${DAY}(,${DAY})*$`, "i");
const TIME = /^\d{1,2}(:\d{2})?(am|pm)?(,\d{1,2}(:\d{2})?(am|pm)?)*$/i;
const ORDINAL = /^\d{1,2}(st|nd|rd|th)?(,\d{1,2}(st|nd|rd|th)?)*$/i;

/**
 * Tokens that belong to `every`'s schedule phrase at the front of the list,
 * decided per head word so a prompt starting with a number after a bare
 * duration is never swallowed. 0 = not a schedule.
 */
export function scheduleLength(tokens: readonly string[]): number {
  const head = (tokens[0] ?? "").toLowerCase();
  const at = (i: number) => tokens[i] ?? "";
  let i = 1;
  const takeTime = () => {
    if (TIME.test(at(i)) && ++i && /^(am|pm)$/i.test(at(i))) i++;
    return i;
  };
  if (DURATION.test(head) || /^(hourly|daily|weekly)$/.test(head)) return 1;
  if (head === "monthly") return ORDINAL.test(at(i)) ? (i++, takeTime()) : takeTime();
  if (/^(day|weekdays|weekends)$/.test(head) || DAYS.test(head)) return takeTime();
  if (head === "once") {
    if (DURATION.test(at(i))) return 2;
    if (/^(today|tomorrow)$/i.test(at(i)) || DAYS.test(at(i)) || /^\d{4}-\d{2}-\d{2}$/.test(at(i))) i++;
    return takeTime();
  }
  return 0;
}

/** Parse the text after `/loop`. Throws a usage error on bad input. */
export function parseLoopArgs(arg: string): LoopRequest {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const [first, second] = tokens;
  if (!first || first === "list" || first === "ls") return { kind: "list" };
  if (/^(log|run|stop|rm|remove)$/.test(first)) {
    if (!second) throw new Error(`/loop ${first} needs a loop name — /loop lists them.`);
    if (first !== "log") return { kind: first === "run" ? "run" : "stop", name: second };
    const n = Number(tokens[2]);
    return { kind: "log", name: second, ...(n > 0 ? { lines: Math.floor(n) } : {}) };
  }
  const opts: { name?: string; timeout?: string; yolo: boolean } = { yolo: false };
  let i = 0;
  const takeOptions = () => {
    for (let t = tokens[i]; t === "--yolo" || t === "--name" || t === "--timeout"; t = tokens[i]) {
      if (t === "--yolo") {
        opts.yolo = true;
        i++;
        continue;
      }
      const v = tokens[++i];
      if (!v || v.startsWith("--")) throw new Error(`${t} needs a value.\n${LOOP_USAGE}`);
      opts[t === "--name" ? "name" : "timeout"] = v;
      i++;
    }
  };
  takeOptions();
  const sep = tokens.indexOf("--", i);
  let when: string;
  if (sep >= 0) {
    when = tokens.slice(i, sep).join(" ");
    i = sep + 1;
  } else {
    const n = scheduleLength(tokens.slice(i));
    if (n === 0) throw new Error(`"${tokens[i] ?? ""}" is not a schedule. Start with when to run, e.g. /loop 15m <prompt>.\n${LOOP_USAGE}`);
    when = tokens.slice(i, i + n).join(" ");
    i += n;
    takeOptions();
  }
  if (!when) throw new Error(`/loop needs a schedule before "--".\n${LOOP_USAGE}`);
  const prompt = tokens.slice(i).join(" ");
  if (!prompt) throw new Error(`/loop ${when} needs a prompt to run.\n${LOOP_USAGE}`);
  return { kind: "add", when, prompt, timeout: opts.timeout ?? DEFAULT_LOOP_TIMEOUT, yolo: opts.yolo, ...(opts.name ? { name: opts.name } : {}) };
}

/** `loop-` + the prompt's opening words, kebab-cased, ≤ 24 chars on a word boundary. */
export function loopNameFor(prompt: string): string {
  const words = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = "";
  for (const w of words) {
    if (slug.length + w.length + (slug ? 1 : 0) > 24) break;
    slug = slug ? `${slug}-${w}` : w;
  }
  slug ||= words[0]?.slice(0, 24) ?? "";
  return slug ? `loop-${slug}` : "loop";
}

/** Quote one argv element for the platform shell `every` runs commands through. */
export function shellQuote(s: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return platform === "win32" ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

export interface AerinInvocation {
  execPath: string;
  argv1: string;
  pathDirs: readonly string[];
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}

/**
 * How a scheduled task starts aerin: bare `aerin` when the login shell will
 * find it on PATH (readable in `every list`), else the runtime + entry running
 * right now (dev checkouts, npx caches, GUI launches with a thin PATH).
 */
export function resolveAerinInvocation(i: AerinInvocation = {
  execPath: process.execPath,
  argv1: process.argv[1] ?? "",
  pathDirs: (process.env["PATH"] ?? "").split(path.delimiter),
  platform: process.platform,
  exists: fs.existsSync,
}): string[] {
  const names = i.platform === "win32" ? ["aerin.cmd", "aerin.exe", "aerin"] : ["aerin"];
  const onPath = path.basename(i.argv1) !== "index.ts" && i.pathDirs.some((d) => d && names.some((n) => i.exists(path.join(d, n))));
  return onPath ? ["aerin"] : [i.execPath, i.argv1];
}

export const LOOP_PROMPT_FLAG = "--prompt-file";

/** The one-line shell command `every` runs. */
export function buildLoopCommand(p: { aerin: readonly string[]; promptFile: string; yolo: boolean; model?: string; platform?: NodeJS.Platform }): string {
  const q = (s: string) => shellQuote(s, p.platform);
  const parts = [...p.aerin.map(q), "-p", "--output-format", "text", LOOP_PROMPT_FLAG, q(p.promptFile)];
  if (p.yolo) parts.push("--yolo");
  if (p.model) parts.push("-m", q(p.model));
  return parts.join(" ");
}

export function loopsDir(): string {
  return path.join(DATA_DIR, "loops");
}

type EveryTask = { name: string; schedule: string; command: string; status: string; paused: boolean; last?: { at: string; exit: number } | null; next?: string | null };

export interface LoopCtx {
  cwd: string;
  /** The session runs with --yolo; loops inherit it. */
  yolo: boolean;
  modelId?: string;
  /** Test seams. */
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

function when(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return iso ?? "—";
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], { ...(today ? {} : { month: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit" });
}

/** Run a `/loop` request. Returns the text the frontend prints. */
export async function loopCommand(ctx: LoopCtx, arg: string): Promise<string> {
  const req = parseLoopArgs(arg);
  const dir = ctx.loopsDir ?? loopsDir();
  const promptFile = (name: string) => path.join(dir, `${name}.md`);
  const noSuch = (name: string) => `no loop "${name}" — /loop lists them`;

  switch (req.kind) {
    case "list": {
      const loops = (await listTasks(ctx.cwd)).filter((t) => t.command.includes(LOOP_PROMPT_FLAG));
      if (loops.length === 0) return "(no loops — /loop <when> <prompt> schedules one, e.g. /loop 15m check CI)";
      const pad = Math.max(...loops.map((l) => l.name.length)) + 2;
      const rows: string[] = [];
      for (const l of loops) {
        const last = l.last ? `last ${when(l.last.at)}${l.last.exit === 0 ? "" : ` (exit ${l.last.exit})`}` : "never ran";
        rows.push(`  ${l.name.padEnd(pad)}${l.schedule.padEnd(16)}${(l.paused ? "paused" : l.status).padEnd(8)}${last} · next ${when(l.next)}`);
        const prompt = await fsp.readFile(promptFile(l.name), "utf8").then((t) => t.trim().replace(/\s+/g, " "), () => "");
        if (prompt) rows.push(`  ${"".padEnd(pad)}${prompt.length > 70 ? `${prompt.slice(0, 69)}…` : prompt}`);
      }
      return `Loops (via every):\n${rows.join("\n")}\n  /loop log <name> · /loop run <name> · /loop stop <name>`;
    }
    case "log": {
      const res = await runEvery(["log", req.name, ...(req.lines ? ["-n", String(req.lines)] : [])], { cwd: ctx.cwd });
      if (res.code === 66) return `no loop "${req.name}" (or it has not run yet) — /loop lists them`;
      return res.output || (res.code === 0 ? "(no runs logged yet)" : `every log failed (exit ${res.code})`);
    }
    case "run": {
      const res = await runEvery(["run", req.name], { cwd: ctx.cwd, timeoutMs: 15 * 60_000 });
      return res.code === 66 ? noSuch(req.name) : `${res.output}${res.code === 0 ? "" : `\n[exit code ${res.code}]`}`;
    }
    case "stop": {
      const res = await runEvery(["rm", req.name], { cwd: ctx.cwd });
      if (res.code === 66) return noSuch(req.name);
      if (res.code !== 0) return `${res.output}\n[every rm failed with exit code ${res.code}]`;
      await fsp.rm(promptFile(req.name), { force: true }).catch(() => {});
      return `stopped ${req.name} (run history kept: every log ${req.name})`;
    }
    case "add": {
      let name = req.name;
      if (!name) {
        // Auto-names must not clobber an existing task with the same opening words.
        const taken = new Set((await listTasks(ctx.cwd)).map((t) => t.name));
        const base = (name = loopNameFor(req.prompt));
        for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      }
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(promptFile(name), `${req.prompt}\n`, "utf8");
      const yolo = req.yolo || ctx.yolo;
      const command = buildLoopCommand({ aerin: ctx.aerin ?? resolveAerinInvocation(), promptFile: promptFile(name), yolo, ...(ctx.modelId ? { model: ctx.modelId } : {}) });
      const res = await runEvery(["set", req.when, "--name", name, "--timeout", req.timeout, "--", command], { cwd: ctx.cwd });
      if (res.code !== 0) {
        await fsp.rm(promptFile(name), { force: true }).catch(() => {});
        return `${res.output}\n(every rejected the loop — check the schedule phrase)\n${LOOP_USAGE}`;
      }
      return [
        `loop ${name}: every ${req.when} → aerin -p ${yolo ? "--yolo " : ""}"${req.prompt.length > 60 ? `${req.prompt.slice(0, 59)}…` : req.prompt}"`,
        `  runs from ${ctx.cwd}, timeout ${req.timeout}, ${yolo ? "tools auto-approved (--yolo)" : "tools limited to read-tier and allow rules (add --yolo to let it edit/run)"}`,
        "  each firing is a fresh session with no memory of the last — pass state through files or the prompt",
        `  /loop log ${name} · /loop run ${name} · /loop stop ${name}`,
        ...(res.output ? [`  ${res.output.split("\n")[0]}`] : []),
      ].join("\n");
    }
  }
}
