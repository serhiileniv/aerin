import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildEveryArgs,
  findEvery,
  resetEveryCache,
  runEvery,
  scheduleTier,
  scheduleTool,
} from "../src/tools/schedule-tool.js";
import { PermissionPolicy, targetFor } from "../src/permissions/policy.js";
import { builtinTools } from "../src/tools/index.js";

const posixOnly = process.platform === "win32" ? test.skip : test;

/**
 * A stand-in `every`: records argv + cwd to a file, then behaves per the
 * FAKE_EVERY_EXIT env var (exit code) and echoes its arguments. Keeps the
 * suite off the user's real launchd/systemd state.
 */
async function fakeEvery(dir: string): Promise<{ bin: string; argsFile: string }> {
  const bin = path.join(dir, "every");
  const argsFile = path.join(dir, "args.txt");
  await fs.writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$PWD" > "${argsFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done
echo "fake every: $*"
if [ -n "$FAKE_EVERY_STDERR" ]; then echo "$FAKE_EVERY_STDERR" >&2; fi
exit "\${FAKE_EVERY_EXIT:-0}"
`,
    { mode: 0o755 },
  );
  return { bin, argsFile };
}

describe("buildEveryArgs", () => {
  test("add uses idempotent `set` and passes the command as ONE token after --", () => {
    expect(
      buildEveryArgs({
        action: "add",
        name: "nightly",
        when: "day 2am",
        command: "bun test && git push",
        timeout: "30m",
        quiet: true,
        on_fail: "say failed",
      }),
    ).toEqual([
      "set", "day 2am", "--name", "nightly", "--quiet", "--timeout", "30m", "--on-fail", "say failed",
      "--", "bun test && git push",
    ]);
  });

  test("read/manage actions map to every's verbs", () => {
    expect(buildEveryArgs({ action: "list" })).toEqual(["list"]);
    expect(buildEveryArgs({ action: "doctor" })).toEqual(["doctor"]);
    expect(buildEveryArgs({ action: "inspect", name: "x" })).toEqual(["inspect", "x"]);
    expect(buildEveryArgs({ action: "log", name: "x", lines: 3 })).toEqual(["log", "x", "-n", "3"]);
    expect(buildEveryArgs({ action: "run", name: "x", dry_run: true })).toEqual(["run", "x", "--dry-run"]);
    expect(buildEveryArgs({ action: "pause", name: "x" })).toEqual(["pause", "x"]);
    expect(buildEveryArgs({ action: "resume", name: "x" })).toEqual(["resume", "x"]);
    expect(buildEveryArgs({ action: "remove", name: "x" })).toEqual(["rm", "x"]);
  });

  test("rejects unknown actions and missing required fields", () => {
    expect(() => buildEveryArgs({ action: "crontab" })).toThrow(/Unknown action/);
    expect(() => buildEveryArgs({ action: "remove" })).toThrow(/needs a task name/);
    expect(() => buildEveryArgs({ action: "add", name: "x", command: "ls" })).toThrow(/needs a schedule/);
    expect(() => buildEveryArgs({ action: "add", name: "x", when: "1h" })).toThrow(/needs a command/);
    expect(() => buildEveryArgs({ action: "add", when: "1h", command: "ls" })).toThrow(/needs a task name/);
  });
});

describe("permission tier and rules", () => {
  test("looking is read-tier, changing is execute-tier", () => {
    expect(scheduleTool.permission).toBe("execute");
    for (const action of ["list", "inspect", "log", "doctor"]) expect(scheduleTier({ action })).toBe("read");
    for (const action of ["add", "run", "pause", "resume", "remove"]) expect(scheduleTier({ action })).toBe("execute");
    expect(scheduleTier({})).toBe("execute");
  });

  test("rules match on '<action> <name>' and 'always' approves the action broadly", () => {
    const t = targetFor("schedule", { action: "add", name: "nightly", when: "1h", command: "ls" });
    expect(t).toEqual({ tool: "schedule", target: "add nightly" });
    expect(PermissionPolicy.ruleFor(t)).toBe("schedule(add *)");

    const p = new PermissionPolicy(["schedule(add *)"], false, ["schedule(remove backup*)"]);
    expect(p.decide("execute", t)).toBe("allow");
    expect(p.decide("execute", targetFor("schedule", { action: "run", name: "nightly" }))).toBe("ask");
    expect(p.decide("execute", targetFor("schedule", { action: "remove", name: "backup-db" }))).toBe("deny");
    expect(p.decide("read", targetFor("schedule", { action: "list" }))).toBe("allow");
  });

  test("is registered as a built-in tool", () => {
    expect(builtinTools().some((t) => t.name === "schedule")).toBe(true);
  });
});

describe("running every", () => {
  let dir: string;
  const savedEnv = { bin: process.env["AERIN_EVERY_BIN"], exit: process.env["FAKE_EVERY_EXIT"], err: process.env["FAKE_EVERY_STDERR"] };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-every-"));
    resetEveryCache();
  });
  afterEach(() => {
    for (const [k, v] of [
      ["AERIN_EVERY_BIN", savedEnv.bin],
      ["FAKE_EVERY_EXIT", savedEnv.exit],
      ["FAKE_EVERY_STDERR", savedEnv.err],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEveryCache();
  });

  test("AERIN_EVERY_BIN overrides discovery", () => {
    process.env["AERIN_EVERY_BIN"] = "/nope/every";
    expect(findEvery()).toBe("/nope/every");
  });

  posixOnly("add spawns every with argv (no shell) in the tool's cwd", async () => {
    const { bin, argsFile } = await fakeEvery(dir);
    process.env["AERIN_EVERY_BIN"] = bin;
    const out = await scheduleTool.execute(
      { action: "add", name: "sync", when: "30m", command: "echo 'a b' | cat" },
      { cwd: dir, allowOutsideCwd: false },
    );
    const recorded = (await fs.readFile(argsFile, "utf8")).trimEnd().split("\n");
    expect(await fs.realpath(recorded[0] ?? "")).toBe(await fs.realpath(dir));
    expect(recorded.slice(1)).toEqual(["set", "30m", "--name", "sync", "--", "echo 'a b' | cat"]);
    expect(out).toContain("fake every: set 30m --name sync -- echo 'a b' | cat");
    expect(out).toContain(`Runs from ${dir}`);
  });

  posixOnly("exit 66 is explained as a missing task", async () => {
    const { bin } = await fakeEvery(dir);
    process.env["AERIN_EVERY_BIN"] = bin;
    process.env["FAKE_EVERY_EXIT"] = "66";
    process.env["FAKE_EVERY_STDERR"] = 'no task "ghost"';
    const out = await scheduleTool.execute({ action: "remove", name: "ghost" }, { cwd: dir, allowOutsideCwd: false });
    expect(out).toContain('no task "ghost"');
    expect(out).toContain("No such task");
  });

  posixOnly("a failing `run` reports the command's exit code", async () => {
    const { bin } = await fakeEvery(dir);
    process.env["AERIN_EVERY_BIN"] = bin;
    process.env["FAKE_EVERY_EXIT"] = "3";
    const out = await scheduleTool.execute({ action: "run", name: "x" }, { cwd: dir, allowOutsideCwd: false });
    expect(out).toContain("[exit code 3]");
  });

  test("a missing binary explains how to install every and forbids cron", async () => {
    process.env["AERIN_EVERY_BIN"] = path.join(dir, "does-not-exist");
    await expect(runEvery(["list"], { cwd: dir })).rejects.toThrow(/not installed[\s\S]*install\.(sh|ps1)[\s\S]*Do not fall back to crontab/);
  });
});
