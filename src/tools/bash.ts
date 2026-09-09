import fs from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";
import treeKill from "tree-kill";
import type { ToolDef } from "./types.js";
import { truncateOutput } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface ShellInfo {
  kind: "bash" | "powershell" | "sh";
  path: string;
  args: (command: string) => string[];
  /** Injected into the system prompt so the model writes valid syntax. */
  promptDescription: string;
}

let cachedShell: ShellInfo | undefined;

/**
 * Windows strategy: prefer Git Bash / any bash on PATH so the model can use
 * POSIX syntax. Fall back to PowerShell and SAY SO in the system prompt —
 * never route model commands through `cmd /c` string concatenation.
 */
export function detectShell(): ShellInfo {
  if (cachedShell) return cachedShell;

  if (process.platform !== "win32") {
    cachedShell = {
      kind: "bash",
      path: "/bin/bash",
      args: (c) => ["-lc", c],
      promptDescription: "POSIX bash",
    };
    if (!fs.existsSync("/bin/bash")) {
      cachedShell = { kind: "sh", path: "/bin/sh", args: (c) => ["-lc", c], promptDescription: "POSIX sh" };
    }
    return cachedShell;
  }

  const bashCandidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env["ProgramFiles"] ? `${process.env["ProgramFiles"]}\\Git\\bin\\bash.exe` : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const candidate of bashCandidates) {
    if (fs.existsSync(candidate)) {
      cachedShell = {
        kind: "bash",
        path: candidate,
        args: (c) => ["-lc", c],
        promptDescription: "POSIX bash (Git Bash on Windows — use forward slashes and Unix syntax)",
      };
      return cachedShell;
    }
  }

  cachedShell = {
    kind: "powershell",
    path: "powershell.exe",
    args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
    promptDescription:
      "Windows PowerShell 5.1 — no `&&` or `||` chaining (use `;`), no Unix commands like grep/sed. Prefer the dedicated file tools.",
  };
  return cachedShell;
}

export const bashTool: ToolDef<z.ZodTypeAny> = {
  name: "bash",
  description:
    "Run a shell command and return combined stdout+stderr with the exit code. The active shell is " +
    "described in the system prompt. For long-running processes (dev servers, watchers), set " +
    "background:true — it returns a job id immediately; read output later with bash_output.",
  permission: "execute",
  inputSchema: z.object({
    command: z.string().describe("The command to run"),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
      .describe("Timeout in milliseconds (default 120000)"),
    cwd: z.string().optional().describe("Working directory override"),
    background: z.boolean().optional()
      .describe("Run detached and return a job id immediately (for servers/watchers)"),
  }),
  summarize: (i) =>
    `Bash(${i.command.length > 80 ? i.command.slice(0, 79) + "…" : i.command}${i.background ? " &" : ""})`,
  async execute(input, ctx) {
    if (input.background) {
      const { startJob } = await import("./bash-jobs.js");
      const job = startJob(input.command, input.cwd ?? ctx.cwd);
      return `Started background job ${job.id}: ${input.command}\nRead its output with bash_output (job: "${job.id}").`;
    }
    const shell = detectShell();
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(shell.path, shell.args(input.command), {
        cwd: input.cwd ?? ctx.cwd,
        windowsHide: true,
        shell: false,
        env: process.env,
      });

      let output = "";
      let killed = false;
      const append = (d: Buffer) => {
        if (output.length < 200_000) output += d.toString();
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const killTree = () => {
        if (child.pid) treeKill(child.pid, "SIGKILL", () => {});
      };

      const timer = setTimeout(() => {
        killed = true;
        killTree();
      }, timeout);

      const onAbort = () => {
        killed = true;
        killTree();
      };
      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        const tail = killed
          ? `\n[command ${ctx.abortSignal?.aborted ? "cancelled" : `timed out after ${timeout}ms`} and was killed]`
          : `\n[exit code: ${code ?? "unknown"}]`;
        resolve(truncateOutput(output + tail));
      });
    });
  },
};
