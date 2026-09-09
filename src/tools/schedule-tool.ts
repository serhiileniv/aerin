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
 * timer units directly — this tool is the one door, so permission rules
 * (`schedule(add *)`, deny `schedule(remove *)`) and the audit trail hold.
 *
 * Actions that only look (list/inspect/log/doctor) are read-tier; anything
 * that changes what runs on the user's machine is execute-tier.
 */

export const SCHEDULE_ACTIONS = ["list", "add", "inspect", "log", "run", "pause", "resume", "remove", "doctor"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

const READ_ACTIONS: ReadonlySet<string> = new Set(["list", "inspect", "log", "doctor"]);
const NAME_ACTIONS: ReadonlySet<string> = new Set(["inspect", "log", "run", "pause", "resume", "remove"]);

/** Exit codes from sysexits.h that `every` uses. */
const EX_USAGE = 64;
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
 * then PATH, then the installer's default locations — aerin may be launched
 * from a GUI or a minimal PATH that doesn't include ~/.local/bin.
 */
export function findEvery(): string {
  const override = process.env["AERIN_EVERY_BIN"];
  if (override) return override;
  if (cachedBinary) return cachedBinary;
  const exe = process.platform === "win32" ? "every.exe" : "every";
  const candidates = [
    path.join(os.homedir(), ".local", "bin", exe),
    ...(process.platform === "win32"
      ? [path.join(process.env["LOCALAPPDATA"] ?? "", "every", "bin", exe)]
      : ["/opt/homebrew/bin/every", "/usr/local/bin/every"]),
  ];
  cachedBinary = candidates.find((c) => c && fs.existsSync(c)) ?? "every";
  return cachedBinary;
}

/** Test seam: forget the resolved binary so a new AERIN_EVERY_BIN/PATH is honored. */
export function resetEveryCache(): void {
  cachedBinary = undefined;
}

/** Build the argv for `every` from a validated tool input. Pure; unit-tested. */
export function buildEveryArgs(input: ScheduleInput): string[] {
  const action = input.action as ScheduleAction;
  const name = input.name?.trim() ?? "";
  if (!SCHEDULE_ACTIONS.includes(action)) {
    throw new Error(`Unknown action "${input.action}". Use one of: ${SCHEDULE_ACTIONS.join(", ")}.`);
  }
  if (NAME_ACTIONS.has(action) && !name) throw new Error(`action "${action}" needs a task name.`);

  switch (action) {
    case "list":
      return ["list"];
    case "doctor":
      return ["doctor"];
    case "inspect":
      return ["inspect", name];
    case "log": {
      const args = ["log", name];
      if (input.lines !== undefined) args.push("-n", String(Math.max(1, Math.floor(input.lines))));
      return args;
    }
    case "run":
      return input.dry_run ? ["run", name, "--dry-run"] : ["run", name];
    case "pause":
    case "resume":
      return [action, name];
    case "remove":
      return ["rm", name];
    case "add": {
      const when = input.when?.trim() ?? "";
      const command = input.command?.trim() ?? "";
      if (!name) throw new Error('action "add" needs a task name (short, kebab-case, e.g. "nightly-tests").');
      if (!when) throw new Error('action "add" needs a schedule ("30m", "day 9am", "weekdays 9:30", "monday 10:00").');
      if (!command) throw new Error('action "add" needs a command to run.');
      // `set` adds or updates in place, so re-scheduling the same name is idempotent.
      const args = ["set", when, "--name", name];
      if (input.quiet) args.push("--quiet");
      if (input.timeout?.trim()) args.push("--timeout", input.timeout.trim());
      if (input.on_fail?.trim()) args.push("--on-fail", input.on_fail.trim());
      // The command is ONE token after `--`; every hands it to the login shell
      // itself, so pipes/&&/globs work and no outer shell strips quotes.
      args.push("--", command);
      return args;
    }
  }
}

export function scheduleTier(input: unknown): PermissionTier {
  const action = String((input as { action?: unknown })?.action ?? "");
  return READ_ACTIONS.has(action) ? "read" : "execute";
}

export interface EveryResult {
  output: string;
  code: number | null;
}

/** Run `every` with argv (no shell) and capture combined output. */
export function runEvery(args: string[], opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<EveryResult> {
  const bin = findEvery();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        windowsHide: true,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter((s) => s && s.trim()).join("\n").trim();
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `\`every\` is not installed (looked for ${bin}). It is the scheduler aerin uses instead of cron — ` +
                `install it with:\n  ${EVERY_INSTALL_HINT}\nthen retry. Do not fall back to crontab, launchd, or systemd timers.`,
            ),
          );
          return;
        }
        if (err && (err as { killed?: boolean }).killed) {
          reject(new Error(`every ${args[0]} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.\n${output}`));
          return;
        }
        const code = err ? ((err as { code?: unknown }).code as number | null) ?? 1 : 0;
        resolve({ output, code: typeof code === "number" ? code : 1 });
      },
    );
  });
}

function describeExit(action: string, name: string | undefined, code: number | null, output: string): string {
  if (code === EX_NOINPUT) {
    return `${output || `no task "${name}"`}\n(No such task${action === "log" ? " or no runs logged yet" : ""} — check the name with action "list".)`;
  }
  if (code === EX_USAGE) return `${output}\n(every rejected the arguments — fix the schedule/name and retry.)`;
  if (action === "run") return `${output}\n[exit code ${code}]`;
  return `${output}\n[every ${action} failed with exit code ${code}]`;
}

export const scheduleTool: ToolDef<z.ZodTypeAny> = {
  name: "schedule",
  description:
    "Schedule, inspect, and manage recurring commands on the user's machine via `every` " +
    "(launchd/systemd/Task Scheduler with run history — the replacement for cron; never edit crontab, " +
    "plists, or timer units yourself). Actions: list (what is scheduled, last/next run, ok/FAIL), " +
    'add (create or update: name + when + command; when is "30m", "hourly", "day 9am", "day 9am,6pm", ' +
    '"weekdays 9:30", "monday,thursday 10:00"), inspect, log (recent runs\' output), run (execute now), ' +
    "pause, resume, remove, doctor (why isn't it running). Tasks run through the login shell in the " +
    "directory they were added from, so relative paths resolve against the current working directory.",
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
    switch (input.action) {
      case "add":
        return `Schedule(add ${input.name ?? "?"}: every ${input.when ?? "?"} -- ${(input.command ?? "").slice(0, 60)})`;
      case "list":
      case "doctor":
        return `Schedule(${input.action})`;
      default:
        return `Schedule(${input.action} ${input.name ?? "?"}${input.dry_run ? " --dry-run" : ""})`;
    }
  },
  async execute(rawInput, ctx) {
    const input = rawInput as ScheduleInput;
    const args = buildEveryArgs(input);
    const timeoutMs = input.action === "run" && !input.dry_run ? RUN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const res = await runEvery(args, { cwd: ctx.cwd, timeoutMs, signal: ctx.abortSignal });
    let text: string;
    if (res.code === 0) {
      text = res.output || (input.action === "list" ? "(nothing scheduled)" : `every ${args.join(" ")}: ok`);
      if (input.action === "add") {
        text += `\n(Runs from ${ctx.cwd}. Check it with action "run" or "inspect"; history with "log".)`;
      }
    } else {
      text = describeExit(input.action, input.name, res.code, res.output);
    }
    return truncateOutput(text);
  },
};
