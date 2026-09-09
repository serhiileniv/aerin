import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createTwoFilesPatch, diffLines } from "diff";
import type { ToolDef, ToolContext } from "./types.js";
import { truncateOutput } from "./types.js";

const DEFAULT_READ_LIMIT = 2000;

function resolvePath(p: string, ctx: ToolContext): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.cwd, p);
}

function assertInsideCwd(abs: string, ctx: ToolContext): void {
  if (ctx.allowOutsideCwd) return;
  const rel = path.relative(path.resolve(ctx.cwd), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to write outside the working directory (${abs}). Re-run aerin with --allow-outside-cwd to permit this.`,
    );
  }
}

const SENSITIVE_RE =
  /[\\/](\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.netrc|\.npmrc|\.git-credentials|id_rsa[^\\/]*|id_ed25519[^\\/]*|credentials)([\\/]|$)/i;

/** Reads auto-run (read tier) — credential-shaped paths outside the workspace are off limits. */
export function assertReadable(abs: string, ctx: ToolContext): void {
  if (ctx.allowOutsideCwd) return;
  const rel = path.relative(path.resolve(ctx.cwd), abs);
  const outside = rel.startsWith("..") || path.isAbsolute(rel);
  if (outside && SENSITIVE_RE.test(abs)) {
    throw new Error(
      `Refusing to read credential-like path outside the working directory (${abs}). Re-run aerin with --allow-outside-cwd if this is intentional.`,
    );
  }
}

/** Detect dominant line ending so edits preserve the file's existing style. */
function detectEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export const readTool: ToolDef<z.ZodTypeAny> = {
  name: "read",
  description:
    "Read a text file from the filesystem. Returns numbered lines. Use offset/limit for large files.",
  permission: "read",
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative to cwd)"),
    offset: z.number().int().min(1).optional().describe("1-based line to start from"),
    limit: z.number().int().min(1).optional().describe("Max lines to return (default 2000)"),
  }),
  summarize: (i) => `Read(${i.path})`,
  async execute(input, ctx) {
    const abs = resolvePath(input.path, ctx);
    assertReadable(abs, ctx);
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) {
      throw new Error(`${input.path} appears to be a binary file`);
    }
    const lines = buf.toString("utf8").split(/\r?\n/);
    const start = (input.offset ?? 1) - 1;
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const slice = lines.slice(start, start + limit);
    const numbered = slice
      .map((l, idx) => `${String(start + idx + 1).padStart(5)}\t${l}`)
      .join("\n");
    const suffix =
      start + limit < lines.length
        ? `\n[${lines.length - start - limit} more lines — re-run with offset=${start + limit + 1}]`
        : "";
    return truncateOutput(numbered + suffix);
  },
};

export const writeTool: ToolDef<z.ZodTypeAny> = {
  name: "write",
  description: "Write content to a file, creating it (and parent directories) if needed. Overwrites existing content.",
  permission: "write",
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative to cwd)"),
    content: z.string().describe("Full file content to write"),
  }),
  summarize: (i) => `Write(${i.path})`,
  async preview(input, ctx) {
    const abs = resolvePath(input.path, ctx);
    let old = "";
    try {
      old = await fs.readFile(abs, "utf8");
    } catch {
      return `(new file, ${input.content.split("\n").length} lines)`;
    }
    return createTwoFilesPatch(input.path, input.path, old, input.content, "before", "after");
  },
  async execute(input, ctx) {
    const abs = resolvePath(input.path, ctx);
    assertInsideCwd(abs, ctx);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    let old: string | undefined;
    try {
      old = await fs.readFile(abs, "utf8");
    } catch {
      // new file
    }
    await fs.writeFile(abs, input.content, "utf8");
    if (old !== undefined) emitDiff(ctx, input.path, old, input.content);
    if (old === undefined) return `Created ${input.path} (${input.content.split("\n").length} lines)`;
    return `Wrote ${input.path} (${diffStat(old, input.content)})`;
  },
};

export const editTool: ToolDef<z.ZodTypeAny> = {
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Include enough surrounding context to make the match unique.",
  permission: "write",
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative to cwd)"),
    old_string: z.string().describe("Exact text to find"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  summarize: (i) => `Update(${i.path})`,
  async preview(input, ctx) {
    const abs = resolvePath(input.path, ctx);
    try {
      const raw = await fs.readFile(abs, "utf8");
      const updated = applyEdit(raw, input.old_string, input.new_string, input.replace_all ?? false);
      return createTwoFilesPatch(input.path, input.path, raw, updated, "before", "after");
    } catch (err) {
      return `(preview unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }
  },
  async execute(input, ctx) {
    const abs = resolvePath(input.path, ctx);
    assertInsideCwd(abs, ctx);
    const raw = await fs.readFile(abs, "utf8");
    const updated = applyEdit(raw, input.old_string, input.new_string, input.replace_all ?? false);
    await fs.writeFile(abs, updated, "utf8");
    emitDiff(ctx, input.path, raw, updated);
    return `Updated ${input.path} (${diffStat(raw, updated)})`;
  },
};

const MAX_DIFF_DISPLAY_LINES = 24;

/** Send a compact diff to the UI (display-only; never enters model context). */
function emitDiff(ctx: ToolContext, label: string, before: string, after: string): void {
  if (!ctx.onProgress) return;
  const patch = createTwoFilesPatch(label, label, before, after, "", "");
  const lines = patch
    .split("\n")
    .filter((l) => !/^(Index: |===|--- |\+\+\+ |\\ No newline)/.test(l));
  const shown = lines.slice(0, MAX_DIFF_DISPLAY_LINES);
  if (lines.length > MAX_DIFF_DISPLAY_LINES) shown.push(`… +${lines.length - MAX_DIFF_DISPLAY_LINES} lines`);
  ctx.onProgress({ type: "tool-display", text: shown.join("\n").trimEnd() });
}

/** "+A -R lines" between two file versions. */
export function diffStat(before: string, after: string): string {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return `+${added} -${removed} lines`;
}

/**
 * Match on LF-normalized text (the #1 Windows edit-tool failure is CRLF
 * mismatch between model output and file bytes), then restore the file's
 * original line-ending style.
 */
export function applyEdit(
  raw: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const eol = detectEol(raw);
  const content = normalizeEol(raw);
  const oldN = normalizeEol(oldString);
  const newN = normalizeEol(newString);

  const count = content.split(oldN).length - 1;
  if (count === 0) {
    throw new Error("old_string not found in file. Read the file again — it may have changed.");
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string matches ${count} times. Add surrounding context to make it unique, or set replace_all.`,
    );
  }
  const updated = replaceAll ? content.split(oldN).join(newN) : content.replace(oldN, newN);
  return eol === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated;
}

export const lsTool: ToolDef<z.ZodTypeAny> = {
  name: "ls",
  description: "List files and directories at a path (non-recursive). Directories are suffixed with /.",
  permission: "read",
  inputSchema: z.object({
    path: z.string().optional().describe("Directory to list (default: cwd)"),
  }),
  summarize: (i) => `List(${i.path ?? "."})`,
  async execute(input, ctx) {
    const abs = resolvePath(input.path ?? ".", ctx);
    assertReadable(abs, ctx);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n");
    return truncateOutput(out || "(empty directory)");
  },
};
