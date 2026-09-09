import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { z } from "zod";
import type { AgentEvent } from "../core/events.js";
import { DATA_DIR } from "../config/paths.js";

export type PermissionTier = "read" | "write" | "execute";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /** Set by --allow-outside-cwd; write tools refuse paths outside cwd otherwise. */
  allowOutsideCwd: boolean;
  /** Long-running tools push mid-execution events here; the agent loop yields them. */
  onProgress?: (event: AgentEvent) => void;
  /** Id of the tool call being executed; set by the agent loop. */
  toolCallId?: string;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  permission: PermissionTier;
  /**
   * Per-call tier override for tools whose actions span tiers (e.g. schedule:
   * list is read, add is execute). Falls back to `permission` when absent.
   */
  tierFor?: (input: z.infer<S>) => PermissionTier;
  /** One-line human-readable summary shown in permission prompts and the transcript. */
  summarize: (input: z.infer<S>) => string;
  /** Optional rich preview for permission dialogs (e.g. a diff). */
  preview?: (input: z.infer<S>, ctx: ToolContext) => Promise<string | undefined>;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_OUTPUT_LINES = 2_000;

const SPILL_RETENTION_MS = 7 * 24 * 3600 * 1000;
let sweptThisProcess = false;

/**
 * Write the FULL text of a truncated output to a spill file (opencode-style),
 * so the model can grep or slice the rest instead of re-running the command.
 * Old spills are swept (7-day retention) once per process. Any failure means
 * no spill — truncation alone still protects the context.
 */
function spillFullOutput(text: string, dir: string): string | undefined {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!sweptThisProcess) {
      sweptThisProcess = true;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try {
          if (Date.now() - fs.statSync(fp).mtimeMs > SPILL_RETENTION_MS) fs.rmSync(fp, { force: true });
        } catch {
          // unreadable entry — leave it
        }
      }
    }
    const file = path.join(dir, `tool-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}.txt`);
    fs.writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Cap tool output so a single result can't blow up the context window.
 * Keeps the head AND the tail — errors and summaries usually live at the
 * end of command output, so pure head-truncation hides exactly what the
 * model needs to see. When anything is cut, the complete output is saved
 * to a spill file and the result points the model at it.
 */
export function truncateOutput(text: string, opts?: { spillDir?: string | false }): string {
  const lines = text.split("\n");
  let out = text;

  if (lines.length > MAX_OUTPUT_LINES) {
    const headLines = Math.floor(MAX_OUTPUT_LINES * 0.75);
    const tailLines = MAX_OUTPUT_LINES - headLines;
    out = [
      ...lines.slice(0, headLines),
      `[... output truncated: ${lines.length - MAX_OUTPUT_LINES} lines omitted ...]`,
      ...lines.slice(-tailLines),
    ].join("\n");
  }

  if (out.length > MAX_OUTPUT_CHARS) {
    const headChars = Math.floor(MAX_OUTPUT_CHARS * 0.7);
    const tailChars = MAX_OUTPUT_CHARS - headChars;
    out =
      out.slice(0, headChars) +
      `\n[... output truncated: ${out.length - MAX_OUTPUT_CHARS} chars omitted ...]\n` +
      out.slice(-tailChars);
  }

  if (out !== text && opts?.spillDir !== false) {
    const file = spillFullOutput(text, opts?.spillDir ?? path.join(DATA_DIR, "spill"));
    if (file) {
      out +=
        `\n[full output (${text.length} chars) saved to ${file} — ` +
        `grep it or read it with offset/limit for the omitted parts instead of re-running the command; ` +
        `for broad analysis, delegate reading it to an agent]`;
    }
  }

  return out;
}
