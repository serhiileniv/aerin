import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLoopCommand,
  loopCommand,
  loopNameFor,
  parseLoopArgs,
  resolveAerinInvocation,
  scheduleLength,
  shellQuote,
} from "../src/core/loop.js";
import { resetEveryCache } from "../src/tools/schedule-tool.js";
import { createPrintFormatter } from "../src/modes/print.js";
import type { AgentEvent } from "../src/core/events.js";

const posixOnly = process.platform === "win32" ? test.skip : test;

describe("parseLoopArgs", () => {
  test("splits every's schedule grammar off the front of the prompt", () => {
    const cases: [string, string, string][] = [
      ["15m check CI", "15m", "check CI"],
      ["hourly summarize new issues", "hourly", "summarize new issues"],
      ["day 9am triage the inbox", "day 9am", "triage the inbox"],
      ["day 9am,6pm run the report", "day 9am,6pm", "run the report"],
      ["weekdays 9:30 prep standup notes", "weekdays 9:30", "prep standup notes"],
      ["monday,thursday 6pm weekly digest", "monday,thursday 6pm", "weekly digest"],
      ["monthly 1st 9am send invoices", "monthly 1st 9am", "send invoices"],
      ["monthly 1,15 18:00 rotate logs", "monthly 1,15 18:00", "rotate logs"],
      ["once tomorrow 9am remind me about the PR", "once tomorrow 9am", "remind me about the PR"],
      ["once friday 5pm wrap up", "once friday 5pm", "wrap up"],
      ["once 2026-12-24 18:00 ship it", "once 2026-12-24 18:00", "ship it"],
      ["once 45m ping me", "once 45m", "ping me"],
      ["day 9 am triage", "day 9 am", "triage"],
      ["mon,thu 6pm digest", "mon,thu 6pm", "digest"],
      ["saturday 10am tidy", "saturday 10am", "tidy"],
    ];
    for (const [input, when, prompt] of cases) {
      expect(parseLoopArgs(input)).toMatchObject({ kind: "add", when, prompt, timeout: "10m", yolo: false });
    }
  });

  test("a bare duration never swallows a prompt that starts with a number", () => {
    expect(scheduleLength(["15m", "3", "times"])).toBe(1);
    expect(parseLoopArgs("15m 3 quick checks of the deploy")).toMatchObject({ when: "15m", prompt: "3 quick checks of the deploy" });
  });

  test("`--` separates an unusual schedule from the prompt explicitly", () => {
    expect(parseLoopArgs("weekends 11am -- 9 things to review")).toMatchObject({ when: "weekends 11am", prompt: "9 things to review" });
  });

  test("options before the prompt: --name, --timeout, --yolo", () => {
    expect(parseLoopArgs("--name ci --yolo 15m check CI")).toMatchObject({ name: "ci", yolo: true, when: "15m", prompt: "check CI" });
    expect(parseLoopArgs("15m --timeout 30m --yolo check CI")).toMatchObject({ timeout: "30m", yolo: true, prompt: "check CI" });
    // Past the prompt start, flags are just words.
    expect(parseLoopArgs("15m check CI --yolo")).toMatchObject({ yolo: false, prompt: "check CI --yolo" });
  });

  test("management verbs", () => {
    expect(parseLoopArgs("")).toEqual({ kind: "list" });
    expect(parseLoopArgs("list")).toEqual({ kind: "list" });
    expect(parseLoopArgs("log ci")).toEqual({ kind: "log", name: "ci" });
    expect(parseLoopArgs("log ci 5")).toEqual({ kind: "log", name: "ci", lines: 5 });
    expect(parseLoopArgs("run ci")).toEqual({ kind: "run", name: "ci" });
    expect(parseLoopArgs("stop ci")).toEqual({ kind: "stop", name: "ci" });
    expect(parseLoopArgs("rm ci")).toEqual({ kind: "stop", name: "ci" });
  });

  test("usage errors name the problem", () => {
    expect(() => parseLoopArgs("check CI every 15 minutes")).toThrow(/not a schedule/);
    expect(() => parseLoopArgs("15m")).toThrow(/needs a prompt/);
    expect(() => parseLoopArgs("stop")).toThrow(/needs a loop name/);
    expect(() => parseLoopArgs("--name")).toThrow(/needs a value/);
    expect(() => parseLoopArgs("-- do it")).toThrow(/needs a schedule/);
  });
});

describe("naming, quoting, invocation", () => {
  test("loop names come from the prompt's opening words", () => {
    expect(loopNameFor("Check CI and report failures!")).toBe("loop-check-ci-and-report");
    expect(loopNameFor("!!!")).toBe("loop");
    expect(loopNameFor("supercalifragilisticexpialidocious now")).toBe("loop-supercalifragilisticexpi");
  });

  test("shellQuote is platform-aware and leaves plain tokens alone", () => {
    expect(shellQuote("aerin", "darwin")).toBe("aerin");
    expect(shellQuote("/a b/c.md", "linux")).toBe("'/a b/c.md'");
    expect(shellQuote("it's", "linux")).toBe("'it'\\''s'");
    expect(shellQuote('C:\\Users\\me\\x y.md', "win32")).toBe('"C:\\Users\\me\\x y.md"');
  });

  test("prefers bare `aerin` on PATH, pins the running entry otherwise", () => {
    const onPath = resolveAerinInvocation({
      execPath: "/usr/bin/node",
      argv1: "/lib/node_modules/aerin-agent/dist/index.js",
      pathDirs: ["/usr/bin", "/opt/homebrew/bin"],
      platform: "darwin",
      exists: (p) => p === "/opt/homebrew/bin/aerin",
    });
    expect(onPath).toEqual(["aerin"]);
    const pinned = resolveAerinInvocation({
      execPath: "/usr/bin/node",
      argv1: "/lib/node_modules/aerin-agent/dist/index.js",
      pathDirs: ["/usr/bin"],
      platform: "darwin",
      exists: () => false,
    });
    expect(pinned).toEqual(["/usr/bin/node", "/lib/node_modules/aerin-agent/dist/index.js"]);
    // A dev checkout runs src/index.ts through bun even if a global aerin exists.
    const dev = resolveAerinInvocation({
      execPath: "/usr/local/bin/bun",
      argv1: "/repo/src/index.ts",
      pathDirs: ["/usr/local/bin"],
      platform: "darwin",
      exists: () => true,
    });
    expect(dev).toEqual(["/usr/local/bin/bun", "/repo/src/index.ts"]);
    expect(
      resolveAerinInvocation({
        execPath: "C:\\node.exe",
        argv1: "C:\\x\\dist\\index.js",
        pathDirs: ["C:\\npm"],
        platform: "win32",
        exists: (p) => p.endsWith("aerin.cmd"),
      }),
    ).toEqual(["aerin"]);
  });

  test("the scheduled command is a headless text run reading the prompt file", () => {
    expect(
      buildLoopCommand({ aerin: ["aerin"], promptFile: "/d/loops/loop-x.md", yolo: false, platform: "linux" }),
    ).toBe("aerin -p --output-format text --prompt-file /d/loops/loop-x.md");
    expect(
      buildLoopCommand({
        aerin: ["/usr/bin/node", "/lib/aerin/dist/index.js"],
        promptFile: "/Users/me/Library/Application Support/aerin/loops/loop-x.md",
        yolo: true,
        model: "anthropic/claude-opus-4-8",
        platform: "darwin",
      }),
    ).toBe(
      "/usr/bin/node /lib/aerin/dist/index.js -p --output-format text --prompt-file " +
        "'/Users/me/Library/Application Support/aerin/loops/loop-x.md' --yolo -m anthropic/claude-opus-4-8",
    );
  });
});

/** Fake `every`: records argv, answers `list --json` from FAKE_EVERY_LIST, exits per FAKE_EVERY_EXIT. */
async function fakeEvery(dir: string): Promise<{ bin: string; argsFile: string }> {
  const bin = path.join(dir, "every");
  const argsFile = path.join(dir, "args.txt");
  await fs.writeFile(
    bin,
    `#!/bin/sh
: > "${argsFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done
if [ "$1" = "list" ]; then echo "\${FAKE_EVERY_LIST:-[]}"; exit 0; fi
echo "fake every: $*"
exit "\${FAKE_EVERY_EXIT:-0}"
`,
    { mode: 0o755 },
  );
  return { bin, argsFile };
}

describe("loopCommand against a fake every", () => {
  let dir: string;
  const saved = { bin: process.env["AERIN_EVERY_BIN"], exit: process.env["FAKE_EVERY_EXIT"], list: process.env["FAKE_EVERY_LIST"] };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-loop-"));
    resetEveryCache();
    const { bin } = await fakeEvery(dir);
    process.env["AERIN_EVERY_BIN"] = bin;
    delete process.env["FAKE_EVERY_EXIT"];
    delete process.env["FAKE_EVERY_LIST"];
  });
  afterEach(() => {
    for (const [k, v] of [
      ["AERIN_EVERY_BIN", saved.bin],
      ["FAKE_EVERY_EXIT", saved.exit],
      ["FAKE_EVERY_LIST", saved.list],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEveryCache();
  });

  const ctx = () => ({ cwd: dir, yolo: false, modelId: "mock/m", loopsDir: path.join(dir, "loops"), aerin: ["aerin"] });

  posixOnly("add writes the prompt file and schedules `every set` with the headless command", async () => {
    const out = await loopCommand(ctx(), "day 9am --timeout 20m check CI and report failures");
    const args = (await fs.readFile(path.join(dir, "args.txt"), "utf8")).trimEnd().split("\n");
    const promptFile = path.join(dir, "loops", "loop-check-ci-and-report.md");
    expect(args).toEqual([
      "set", "day 9am", "--name", "loop-check-ci-and-report", "--timeout", "20m", "--",
      `aerin -p --output-format text --prompt-file ${shellQuote(promptFile)} -m mock/m`,
    ]);
    expect(await fs.readFile(promptFile, "utf8")).toBe("check CI and report failures\n");
    expect(out).toContain("loop loop-check-ci-and-report: every day 9am");
    expect(out).toContain("add --yolo");
    expect(out).not.toContain("cron");
  });

  posixOnly("--yolo (or a --yolo session) makes the scheduled run auto-approve", async () => {
    await loopCommand({ ...ctx(), yolo: true }, "15m tidy the changelog");
    const args = (await fs.readFile(path.join(dir, "args.txt"), "utf8")).trimEnd().split("\n");
    expect(args.at(-1)).toContain(" --yolo");
  });

  posixOnly("auto-names skip names every already has", async () => {
    process.env["FAKE_EVERY_LIST"] = JSON.stringify([
      { name: "loop-check-ci", schedule: "15m", command: "x --prompt-file y", status: "ok", paused: false, scheduled: true },
    ]);
    const out = await loopCommand(ctx(), "30m check CI");
    expect(out).toContain("loop loop-check-ci-2:");
  });

  posixOnly("a rejected schedule removes the prompt file and explains", async () => {
    process.env["FAKE_EVERY_EXIT"] = "64";
    const out = await loopCommand(ctx(), "--name bad 15m do it");
    expect(out).toContain("every rejected the loop");
    expect(await fs.readdir(path.join(dir, "loops"))).toEqual([]);
  });

  posixOnly("list shows only loops (tasks that read a prompt file) with their prompts", async () => {
    await fs.mkdir(path.join(dir, "loops"), { recursive: true });
    await fs.writeFile(path.join(dir, "loops", "loop-ci.md"), "check CI\n");
    process.env["FAKE_EVERY_LIST"] = JSON.stringify([
      { name: "backup", schedule: "day 2am", command: "tar czf x", status: "ok", paused: false, scheduled: true, last: null, next: null },
      {
        name: "loop-ci", schedule: "15m", command: "aerin -p --output-format text --prompt-file /x/loop-ci.md",
        status: "FAIL", paused: false, scheduled: true, last: { at: new Date().toISOString(), exit: 1, seconds: 2 }, next: null,
      },
    ]);
    const out = await loopCommand(ctx(), "");
    expect(out).toContain("loop-ci");
    expect(out).toContain("FAIL");
    expect(out).toContain("(exit 1)");
    expect(out).toContain("check CI");
    expect(out).not.toContain("backup");
    process.env["FAKE_EVERY_LIST"] = "[]";
    expect(await loopCommand(ctx(), "list")).toContain("no loops");
  });

  posixOnly("stop removes the task and its prompt file; unknown names are explained", async () => {
    await fs.mkdir(path.join(dir, "loops"), { recursive: true });
    await fs.writeFile(path.join(dir, "loops", "loop-ci.md"), "check CI\n");
    expect(await loopCommand(ctx(), "stop loop-ci")).toContain("stopped loop-ci");
    expect(await fs.readdir(path.join(dir, "loops"))).toEqual([]);
    process.env["FAKE_EVERY_EXIT"] = "66";
    expect(await loopCommand(ctx(), "stop ghost")).toContain('no loop "ghost"');
    expect(await loopCommand(ctx(), "log ghost")).toContain('no loop "ghost"');
  });

  posixOnly("log and run pass through to every", async () => {
    expect(await loopCommand(ctx(), "log loop-ci 3")).toContain("fake every: log loop-ci -n 3");
    expect(await loopCommand(ctx(), "run loop-ci")).toContain("fake every: run loop-ci");
    process.env["FAKE_EVERY_EXIT"] = "2";
    expect(await loopCommand(ctx(), "run loop-ci")).toContain("[exit code 2]");
  });
});

describe("print formatter", () => {
  const collect = (format: "text" | "json", events: AgentEvent[]) => {
    let out = "";
    let err = "";
    const fmt = createPrintFormatter(format, (s) => (out += s), (s) => (err += s));
    for (const e of events) fmt.onEvent(e);
    const isError = fmt.finish({ sessionId: "s1", model: "mock/m" });
    return { out, err, isError };
  };
  const turn: AgentEvent[] = [
    { type: "text-delta", text: "Looking" },
    { type: "text-delta", text: " first.\n" },
    { type: "message-end" },
    { type: "tool-call", id: "1", name: "bash", input: {}, summary: "Bash(ls)" },
    { type: "tool-result", id: "1", name: "bash", output: "a", isError: false },
    { type: "text-delta", text: "Done: **ok**" },
    { type: "message-end" },
    { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    { type: "turn-end" },
  ];

  test("text: streams, one newline per message, never doubled, diagnostics on stderr", () => {
    const r = collect("text", turn);
    expect(r.out).toBe("Looking first.\nDone: **ok**\n");
    expect(r.err).toBe("[tool] Bash(ls)\n");
    expect(r.isError).toBe(false);
  });

  test("text: an unterminated final message still ends the output with a newline", () => {
    expect(collect("text", [{ type: "text-delta", text: "hi" }]).out).toBe("hi\n");
    expect(collect("text", []).out).toBe("");
  });

  test("json: one object on stdout with result, usage, session, tool count", () => {
    const r = collect("json", [...turn, { type: "error", message: "boom" }]);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      result: "Looking first.\n\nDone: **ok**",
      isError: true,
      error: "boom",
      sessionId: "s1",
      model: "mock/m",
      toolCalls: 1,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    expect(r.err).toContain("error: boom");
    expect(r.isError).toBe(true);
  });
});
