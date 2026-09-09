import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import type { PermissionTier, ToolDef } from "./types.js";
import { truncateOutput } from "./types.js";

/**
 * Native scheduling through `every` (https://github.com/serhiileniv/every):
 * launchd on macOS, systemd user timers on Linux, Task Scheduler on Windows,
 * with a memory of every run. The agent never touches crontab / plists /
 * timer units — this tool is the one door, so permission rules
 * (`schedule(add *)`, deny `schedule(remove *)`) and the audit trail hold.
 * Looking (list/inspect/log/doctor) is read-tier; changing what runs on the
 * user's machine is execute-tier.
 */

export const SCHEDULE_ACTIONS = ["list", "add", "inspect", "log", "run", "pause", "resume", "remove", "doctor"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];
const READ_ACTIONS = new Set(["list", "inspect", "log", "doctor"]);
const EX_USAGE = 64; // sysexits.h codes every uses
const EX_NOINPUT = 66;
const RUN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const EVERY_INSTALL_HINT =
  process.platform === "win32"
    ? "irm https://raw.githubusercontent.com/serhiileniv/every/main/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/serhiileniv/every/main/install.sh | sh";

export interface ScheduleInput {
  action: string;
  name?: string;
  when?: string;
  command?: string;
  timeout?: string;
  quiet?: boolean;
  on_fail?: string;
  lines?: number;
  dry_run?: boolean;
}

let cachedBinary: string | undefined;

/**
 * Resolve the `every` binary: an explicit override (tests, unusual installs),
 * then the installer's default locations — aerin may be launched from a GUI
 * or a minimal PATH that lacks ~/.local/bin — then bare `every` on PATH.
 */
export function findEvery(): string {
  const override = process.env["AERIN_EVERY_BIN"];
  if (override) return override;
  const exe = process.platform === "win32" ? "every.exe" : "every";
  const candidates = [
    path.join(os.homedir(), ".local", "bin", exe),
    ...(process.platform === "win32"
      ? [path.join(process.env["LOCALAPPDATA"] ?? "", "every", "bin", exe)]
      : ["/opt/homebrew/bin/every", "/usr/local/bin/every"]),
  ];
  return (cachedBinary ??= candidates.find((c) => c && fs.existsSync(c)) ?? "every");
}

/** Test seam: forget the resolved binary so a new AERIN_EVERY_BIN/PATH is honored. */
export function resetEveryCache(): void {
  cachedBinary = undefined;
}

/** Build the argv for `every` from a validated tool input. Pure; unit-tested. */
export function buildEveryArgs(input: ScheduleInput): string[] {
  const action = input.action as ScheduleAction;
  const name = input.name?.trim() ?? "";
  if (!SCHEDULE_ACTIONS.includes(action)) throw new Error(`Unknown action "${input.action}". Use one of: ${SCHEDULE_ACTIONS.join(", ")}.`);
  if (!name && !["list", "doctor"].includes(action)) {
    throw new Error(`action "${action}" needs a task name${action === "add" ? ' (short, kebab-case, e.g. "nightly-tests")' : ""}.`);
  }
  switch (action) {
    case "list":
    case "doctor":
      return [action];
    case "inspect":
    case "pause":
    case "resume":
      return [action, name];
    case "remove":
      return ["rm", name];
    case "log":
      return ["log", name, ...(input.lines !== undefined ? ["-n", String(Math.max(1, Math.floor(input.lines)))] : [])];
    case "run":
      return ["run", name, ...(input.dry_run ? ["--dry-run"] : [])];
    case "add": {
      const when = input.when?.trim() ?? "";
      const command = input.command?.trim() ?? "";
      if (!when) throw new Error('action "add" needs a schedule ("30m", "day 9am", "weekdays 9:30", "monday 10:00").');
      if (!command) throw new Error('action "add" needs a command to run.');
      // `set` adds or updates in place. The command is ONE token after `--`;
      // every hands it to the login shell itself, so pipes/&&/globs work.
      const args = ["set", when, "--name", name];
      if (input.quiet) args.push("--quiet");
      if (input.timeout?.trim()) args.push("--timeout", input.timeout.trim());
      if (input.on_fail?.trim()) args.push("--on-fail", input.on_fail.trim());
      return [...args, "--", command];
    }
  }
}

export function scheduleTier(input: unknown): PermissionTier {
  return READ_ACTIONS.has(String((input as { action?: unknown })?.action ?? "")) ? "read" : "execute";
}

export interface EveryResult {
  output: string;
  code: number | null;
}

/** Run `every` with argv (no shell) and capture combined output. */
export function runEvery(args: string[], opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<EveryResult> {
  const bin = findEvery();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: opts.cwd, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter((s) => s?.trim()).join("\n").trim();
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e?.code === "ENOENT") {
        reject(
          new Error(
            `\`every\` is not installed (looked for ${bin}). It is the scheduler aerin uses instead of cron — install it with:\n  ${EVERY_INSTALL_HINT}\nthen retry. Do not fall back to crontab, launchd, or systemd timers.`,
          ),
        );
      } else if (e?.killed) reject(new Error(`every ${args[0]} timed out after ${timeout}ms.\n${output}`));
      else resolve({ output, code: e ? (typeof e.code === "number" ? e.code : 1) : 0 });
    });
  });
}

function describeExit(action: string, name: string | undefined, code: number | null, output: string): string {
  if (code === EX_NOINPUT) return `${output || `no task "${name}"`}\n(No such task${action === "log" ? " or no runs logged yet" : ""} — check the name with action "list".)`;
  if (code === EX_USAGE) return `${output}\n(every rejected the arguments — fix the schedule/name and retry.)`;
  return `${output}\n[${action === "run" ? "" : `every ${action} failed with `}exit code ${code}]`;
}

export const scheduleTool: ToolDef<z.ZodTypeAny> = {
  name: "schedule",
  description:
    "Schedule, inspect, and manage recurring commands on the user's machine via `every` (launchd/systemd/Task Scheduler with run history — " +
    "the replacement for cron; never edit crontab, plists, or timer units yourself). Actions: list (what is scheduled, last/next run, ok/FAIL), " +
    'add (create or update: name + when + command; when is "30m", "hourly", "day 9am", "day 9am,6pm", "weekdays 9:30", "monday,thursday 10:00"), ' +
    "inspect, log (recent runs' output), run (execute now), pause, resume, remove, doctor (why isn't it running). Tasks run through the login " +
    "shell in the directory they were added from, so relative paths resolve against the current working directory.",
  inputSchema: z.object({
    action: z.string().describe('One of: "list", "add", "inspect", "log", "run", "pause", "resume", "remove", "doctor"'),
    name: z.string().optional().describe("Task name (required for everything except list/doctor); short kebab-case"),
    when: z.string().optional().describe('add: the schedule phrase, e.g. "15m", "day 9am", "weekdays 9:30", "monday 10:00"'),
    command: z.string().optional().describe("add: the shell line to run (pipes, &&, globs allowed)"),
    timeout: z.string().optional().describe('add: kill a run that overruns, e.g. "30m" (recommended for anything that can hang)'),
    quiet: z.boolean().optional().describe("add: suppress the desktop notification on failure"),
    on_fail: z.string().optional().describe("add: a command to run when a run fails"),
    lines: z.number().int().min(1).max(100).optional().describe("log: how many recent runs to show"),
    dry_run: z.boolean().optional().describe("run: show what would run (shell, directory, command) without running it"),
  }),
  permission: "execute",
  tierFor: scheduleTier,
  summarize: (i) => {
    const input = i as ScheduleInput;
    if (input.action === "add") return `Schedule(add ${input.name ?? "?"}: every ${input.when ?? "?"} -- ${(input.command ?? "").slice(0, 60)})`;
    if (input.action === "list" || input.action === "doctor") return `Schedule(${input.action})`;
    return `Schedule(${input.action} ${input.name ?? "?"}${input.dry_run ? " --dry-run" : ""})`;
  },
  async execute(rawInput, ctx) {
    const input = rawInput as ScheduleInput;
    const args = buildEveryArgs(input);
    const timeoutMs = input.action === "run" && !input.dry_run ? RUN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const res = await runEvery(args, { cwd: ctx.cwd, timeoutMs, signal: ctx.abortSignal });
    if (res.code !== 0) return truncateOutput(describeExit(input.action, input.name, res.code, res.output));
    let text = res.output || (input.action === "list" ? "(nothing scheduled)" : `every ${args.join(" ")}: ok`);
    if (input.action === "add") text += `\n(Runs from ${ctx.cwd}. Check it with action "run" or "inspect"; history with "log".)`;
    return truncateOutput(text);
  },
};
