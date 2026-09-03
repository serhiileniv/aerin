import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ModelMessage } from "ai";
import { setupAgent, stopMcpServers } from "../cli.js";
import type { AskUser } from "../tools/question-tool.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { messageText, redactSecrets, setTerminalTitle } from "../terminal/format.js";
import { filterChunk } from "../terminal/input-filter.js";
import { resolveModel } from "../providers/registry.js";
import type { OnPermission } from "../core/events.js";
import { App, type TuiSetup } from "./App.js";

interface TuiFlags {
  model?: string;
  yolo: boolean;
  continue: boolean;
  resume?: string;
  allowOutsideCwd: boolean;
  cwd?: string;
  mcp: boolean;
}

export async function runTui(flags: TuiFlags, initialPrompt?: string): Promise<void> {
  // The Agent needs onPermission at construction, but the dialog only exists
  // once the App mounts — so route through swappable refs.
  const onPermissionRef: { current: OnPermission } = {
    current: async () => ({ kind: "deny", reason: "UI not ready" }),
  };
  const onQuestionRef: { current: AskUser } = {
    current: async () => {
      throw new Error("UI not ready");
    },
  };

  const setup = await setupAgent(
    flags,
    (req) => onPermissionRef.current(req),
    (q, options) => onQuestionRef.current(q, options),
  );

  const tuiSetup: TuiSetup = {
    agent: setup.agent,
    modelId: setup.modelId,
    cwd: setup.cwd,
    warnings: setup.warnings,
    onPermissionRef,
    onQuestionRef,
    policy: setup.policy,
    customCommands: setup.customCommands,
    skills: setup.skills,
    mcpConnections: setup.mcpConnections,
    sessionId: setup.sessionId,
    resolveModelFn: (id) => resolveModel(id, setup.config),
    config: setup.config,
    ...(setup.modelUnavailable !== undefined ? { modelUnavailable: setup.modelUnavailable } : {}),
  };

  // Full-screen app on the alternate screen buffer (opencode-style): the UI
  // owns the whole window — there is nothing above it to scroll into — and
  // the user's shell scrollback is restored intact on exit. SGR mouse
  // reporting is enabled so the wheel scrolls the transcript in-app; the
  // sequences are stripped from stdin BEFORE Ink parses them (Ink would
  // otherwise insert them into the input as garbage text).
  const mouse = new EventEmitter();
  tuiSetup.mouse = mouse;
  // AERIN_SMOKE=1: CI smoke mode — pretend the streams are a TTY so the full
  // render pipeline runs headless, then self-exit via a synthesized /exit.
  const smoke = process.env["AERIN_SMOKE"] === "1";
  const filteredStdin = new PassThrough();
  Object.assign(filteredStdin, {
    isTTY: smoke || process.stdin.isTTY,
    setRawMode: (mode: boolean) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(mode);
      return filteredStdin;
    },
    ref: () => process.stdin.ref?.(),
    unref: () => process.stdin.unref?.(),
  });
  if (smoke) {
    // One keystroke per chunk — coalesced writes would parse as pasted text.
    [..."/exit\r"].forEach((ch, i) => {
      setTimeout(() => filteredStdin.write(ch), 1500 + i * 80);
    });
  }

  let carry = "";
  let carryTimer: ReturnType<typeof setTimeout> | undefined;
  const onStdinData = (chunk: Buffer): void => {
    if (carryTimer) clearTimeout(carryTimer);
    const result = filterChunk(carry, chunk.toString("utf8"));
    carry = result.carry;
    for (const dir of result.wheel) mouse.emit("wheel", dir);
    if (result.clean.length > 0) filteredStdin.write(result.clean);
    if (carry) {
      // Flush held-back bytes shortly if no continuation arrives — they were
      // real input, not a mouse event.
      carryTimer = setTimeout(() => {
        if (carry) {
          filteredStdin.write(carry);
          carry = "";
        }
      }, 60);
    }
  };
  process.stdin.on("data", onStdinData);
  process.stdin.resume(); // background detection may have left stdin explicitly paused

  // Restore EVERYTHING the TUI changed, on every exit path: bracketed paste
  // and mouse reporting off, back to the normal screen, cursor visible again
  // (Ink hides it and only restores on a clean unmount), and raw mode off
  // (otherwise the shell stops echoing keystrokes). Idempotent — it runs from
  // the finally block, the process exit hook, and signal handlers.
  const restoreTerminal = (): void => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // stdin already closed — nothing to restore
    }
    process.stdout.write("\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?1049l\x1b[?25h");
  };
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h\x1b[?2004h");
  process.once("exit", restoreTerminal);
  // Signals kill the process without running finally blocks — clean up first.
  // (SIGKILL and a hard console close can still skip this; nothing can catch those.)
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      restoreTerminal();
      process.exit(sig === "SIGTERM" ? 143 : 129);
    });
  }
  setTerminalTitle("aerin");

  try {
    const instance = render(<App setup={tuiSetup} {...(initialPrompt ? { initialPrompt } : {})} />, {
      exitOnCtrlC: false,
      stdin: filteredStdin as unknown as NodeJS.ReadStream,
    });
    await instance.waitUntilExit();
  } finally {
    process.stdin.removeListener("data", onStdinData);
    process.stdin.pause();
    restoreTerminal();
    setTerminalTitle(""); // hand the title back to the shell
    // The alt screen took the conversation with it — leave a plain transcript
    // in the normal terminal so the session survives in scrollback.
    printTranscript(setup.agent.history);
    const { runLifecycleHook } = await import("../core/hooks.js");
    await runLifecycleHook(
      setup.config.hooks,
      "session:end",
      { sessionId: setup.sessionId, messages: setup.agent.history.length },
      setup.cwd,
    );
    await stopMcpServers(setup.mcpConnections);
    // index.ts force-exits after main() resolves — nothing left to do here.
  }
}

function printTranscript(history: readonly ModelMessage[]): void {
  // Prompts and replies only — tool-call noise ("ls", "read", ...) has no
  // value in shell scrollback and reads as ugly leftovers.
  const out: string[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const t = messageText(m).trim();
      if (t && !t.startsWith("[Conversation compacted")) out.push(`> ${t.split("\n")[0]?.slice(0, 200) ?? ""}`);
    } else if (m.role === "assistant") {
      const t = messageText(m).trim();
      if (t) out.push(renderMarkdown(t, (process.stdout.columns ?? 80) - 2));
    }
  }
  if (out.length === 0) return;
  // Never let key-shaped strings land in shell scrollback.
  process.stdout.write(`\n─── aerin session ───\n\n${redactSecrets(out.join("\n\n"))}\n\n`);
}
