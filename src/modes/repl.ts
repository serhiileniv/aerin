import readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { setupAgent, teardown, type RunFlags } from "../cli.js";
import { diagnostic } from "./print.js";
import type { PermissionDecision, PermissionRequest } from "../core/events.js";
import { SessionStore, type SessionSummary } from "../session/store.js";
import { colorizeDiff, relativeTime } from "../terminal/format.js";
import { discoverModels } from "../providers/list-models.js";
import { resolveModel } from "../providers/registry.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { persistModelChoice } from "../config/config.js";
import { renderCommand } from "../core/commands.js";
import { catalogEntry } from "../providers/catalog.js";
import {
  compactCommand,
  goalCommand,
  loopCommand,
  connectCommand,
  helpLines,
  mcpCommand,
  resumeById,
  skillsCommand,
  statusCommand,
  togglePlan,
  undoCommand,
  redoCommand,
} from "../core/session-commands.js";
import { expandMentions } from "../core/mentions.js";

const REPL_ONLY = [{ name: "/models", description: "list models available from your providers" }];

/** Plain readline REPL — no Ink. Kept forever as the TUI's debugging lifeline. */
export async function runRepl(flags: RunFlags, initialPrompt?: string): Promise<void> {
  // Created only after setup: attaching readline earlier would emit (and drop)
  // any input lines that arrive while setup is still running, e.g. piped stdin.
  let rl!: ReturnType<typeof readline.createInterface>;

  const askPermission = async (req: PermissionRequest): Promise<PermissionDecision> => {
    stdout.write(`\n  ${req.summary}\n`);
    if (req.preview) stdout.write(indent(req.preview, "  | ") + "\n");
    const answer = (await rl.question("  Allow? [y]es / [a]lways (project) / [n]o: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { kind: "allow" };
    if (answer === "a" || answer === "always") return { kind: "allow-always", scope: "project" };
    const reason = (await rl.question("  Tell the agent what to do instead (optional): ")).trim();
    return { kind: "deny", ...(reason ? { reason } : {}) };
  };

  const askQuestion = async (question: string, options: string[]): Promise<string> => {
    stdout.write(`\n  ? ${question}\n`);
    options.forEach((o, i) => stdout.write(`    ${i + 1}. ${o}\n`));
    const answer = (await rl.question("  answer (number or free text): ")).trim();
    const n = Number(answer);
    return Number.isInteger(n) && options[n - 1] ? (options[n - 1] as string) : answer;
  };

  const setup = await setupAgent(flags, askPermission, askQuestion);
  rl = readline.createInterface({ input: stdin, output: stdout });
  for (const w of setup.warnings) stderr.write(`warning: ${w}\n`);
  const { VERSION } = await import("../version.js");
  stdout.write(`● aerin v${VERSION} · ${setup.modelId}\n  ${setup.cwd} · /help for commands\n\n`);

  let running = false;
  rl.on("SIGINT", () => {
    if (running) {
      setup.agent.abort();
    } else {
      stdout.write("\n");
      rl.close();
    }
  });

  // Humans (TTY) get each message rendered as markdown once it completes;
  // pipes/scripts get the raw token stream so output stays machine-readable.
  const renderForTty = stdout.isTTY === true;

  const runTurn = async (prompt: string): Promise<void> => {
    running = true;
    const turnStart = Date.now();
    let textBuf = "";
    const expanded = await expandMentions(prompt, setup.cwd).catch(() => ({ text: prompt, images: [] }));
    try {
      for await (const event of setup.agent.send(expanded.text, expanded.images)) {
        switch (event.type) {
          case "text-delta":
            if (renderForTty) textBuf += event.text;
            else stdout.write(event.text);
            break;
          case "message-end":
            if (renderForTty) {
              stdout.write(renderMarkdown(textBuf, (stdout.columns ?? 80) - 2) + "\n");
              textBuf = "";
            } else {
              stdout.write("\n");
            }
            break;
          case "tool-call":
            stdout.write(`\n  ● ${event.summary}\n`);
            break;
          case "compaction":
            stdout.write(`  [compacting context — was ${event.preTokens} tokens]\n`);
            break;
          case "tool-display":
            stdout.write(colorizeDiff(event.text) + "\n");
            break;
          case "todo-update":
            for (const t of event.items) {
              stdout.write(`  ${t.status === "done" ? "✓" : t.status === "active" ? "●" : "○"} ${t.text}\n`);
            }
            break;
          default: {
            const line = diagnostic(event);
            if (line) stdout.write(`  ${line}\n`);
          }
        }
      }
    } finally {
      running = false;
      // A message cut short by interrupt/error never saw message-end — don't drop it.
      if (renderForTty && textBuf.trim()) stdout.write(renderMarkdown(textBuf, (stdout.columns ?? 80) - 2) + "\n");
    }
    const cost = setup.agent.totalCostUsd;
    const secs = Math.round((Date.now() - turnStart) / 1000);
    stdout.write(
      `  [${secs >= 3 ? `${secs}s / ` : ""}${setup.agent.totalInputTokens} in / ${setup.agent.totalOutputTokens} out${cost ? ` / ~$${cost.toFixed(4)}` : ""}]\n\n`,
    );
  };

  // Numbered entries from the last bare /resume, consumed by "/resume <n>".
  let resumeChoices: SessionSummary[] = [];

  // "quit" ends the REPL; anything else continues.
  const handleLine = async (line: string): Promise<"quit" | undefined> => {
      if (!line) return undefined;
      if (line === "/exit" || line === "/quit") return "quit";
      if (line === "/help") {
        stdout.write(`Commands:\n${helpLines(setup, REPL_ONLY).join("\n")}\nAnything else is sent to the agent. Ctrl+C interrupts a running turn.\n`);
        return undefined;
      }
      if (line === "/undo") {
        stdout.write(`  ${await undoCommand(setup)}\n`);
        return undefined;
      }
      if (line === "/redo") {
        stdout.write(`  ${await redoCommand(setup)}\n`);
        return undefined;
      }
      if (line.startsWith("/connect")) {
        const [, prov, key, url, protoArg] = line.split(/\s+/);
        if (!prov || !key) stdout.write("  usage: /connect <provider> <api-key> [baseURL] [openai|anthropic]\n");
        else if (protoArg && protoArg !== "openai" && protoArg !== "anthropic") stdout.write(`  ✗ unknown protocol "${protoArg}" — expected "openai" or "anthropic"\n`);
        else {
          const protocol = (protoArg as "openai" | "anthropic" | undefined) ?? catalogEntry(prov)?.protocol;
          await connectCommand(setup, prov, key, url ?? catalogEntry(prov)?.baseURL, protocol, (_, t) => stdout.write(`  ${t}\n`));
        }
        return undefined;
      }
      if (line === "/status") {
        const { VERSION } = await import("../version.js");
        stdout.write(
          statusCommand(setup, { modelId: setup.agent.modelId, version: VERSION }) + "\n",
        );
        return undefined;
      }
      if (line === "/skills") {
        stdout.write(skillsCommand(setup) + "\n");
        return undefined;
      }
      if (line === "/mcp") {
        stdout.write(mcpCommand(setup) + "\n");
        return undefined;
      }
      if (line === "/goal" || line.startsWith("/goal ")) {
        const res = goalCommand(setup, line.slice("/goal".length).trim());
        stdout.write(res.message + "\n");
        if (res.run) await runTurn(res.run);
        return undefined;
      }
      if (line === "/loop" || line.startsWith("/loop ")) {
        try {
          stdout.write(`  ${(await loopCommand(setup, line.slice("/loop".length).trim())).replace(/\n/g, "\n  ")}\n`);
        } catch (err) {
          stdout.write(`  ${(err instanceof Error ? err.message : String(err)).replace(/\n/g, "\n  ")}\n`);
        }
        return undefined;
      }
      if (line === "/plan") {
        const next = togglePlan(setup);
        stdout.write(next === "plan" ? "  (plan mode ON — read-only)\n" : "  (plan mode OFF)\n");
        return undefined;
      }
      if (line === "/clear") {
        await setup.agent.clear();
        stdout.write("  (history cleared)\n");
        return undefined;
      }
      if (line === "/compact") {
        try {
          stdout.write(`  ${(await compactCommand(setup)).message}\n`);
        } catch (err) {
          stdout.write(`  compact failed: ${err instanceof Error ? err.message : err}\n`);
        }
        return undefined;
      }
      if (line === "/resume") {
        resumeChoices = (await SessionStore.list(setup.cwd)).filter((s) => s.messageCount > 0).slice(0, 20);
        if (resumeChoices.length === 0) {
          stdout.write("  (no previous conversations in this directory)\n");
          return undefined;
        }
        resumeChoices.forEach((s, i) => {
          stdout.write(
            `  ${String(i + 1).padStart(2)}. ${relativeTime(s.createdAt).padEnd(11)} ${String(s.messageCount).padStart(3)} msg  ${s.title ?? "(no prompt yet)"}\n`,
          );
        });
        stdout.write("  pick one with: /resume <number>\n");
        return undefined;
      }
      if (line.startsWith("/resume ")) {
        const arg = line.slice("/resume ".length).trim();
        const id = /^\d+$/.test(arg) ? resumeChoices[Number(arg) - 1]?.id : arg;
        if (!id) {
          stdout.write("  no such entry — run /resume to list conversations first\n");
          return undefined;
        }
        try {
          const messages = await resumeById(setup, id);
          stdout.write(`  resumed conversation (${messages.length} messages)\n`);
        } catch (err) {
          stdout.write(`  resume failed: ${err instanceof Error ? err.message : err}\n`);
        }
        return undefined;
      }
      if (line === "/models") {
        stdout.write("  fetching model lists from your providers...\n");
        const { models, warnings } = await discoverModels(setup.config);
        for (const w of warnings) stderr.write(`  warning: ${w}\n`);
        if (models.length === 0) stdout.write("  (no provider reachable — set an API key first)\n");
        for (const m of models) stdout.write(`  ${m.id}\n`);
        return undefined;
      }
      if (line.startsWith("/model ")) {
        const id = line.slice("/model ".length).trim();
        try {
          setup.agent.setModel(resolveModel(id, setup.config), id);
          await persistModelChoice(id).catch(() => {});
          stdout.write(`  model switched to ${id}\n`);
        } catch (err) {
          stdout.write(`  ${err instanceof Error ? err.message : err}\n`);
        }
        return undefined;
      }
      if (line.startsWith("/")) {
        const bare = line.slice(1).split(/\s+/)[0] ?? "";
        const custom = setup.customCommands.find((c) => c.name === bare);
        if (custom) {
          await runTurn(renderCommand(custom, line.slice(bare.length + 1).trim()));
          return undefined;
        }
      }
      await runTurn(line);
      return undefined;
  };

  try {
    if (initialPrompt) await runTurn(initialPrompt);
    // The async iterator (unlike rl.question) buffers lines that arrive while
    // a command is still being processed — required for piped stdin.
    stdout.write("> ");
    for await (const raw of rl) {
      if (await handleLine(raw.trim()) === "quit") break;
      stdout.write("> ");
    }
  } finally {
    rl.close();
    await teardown(setup);
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .slice(0, 40)
    .map((l) => prefix + l)
    .join("\n");
}

