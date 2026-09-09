import fs from "node:fs";
import { stdout } from "node:process";
import { spawnSync } from "node:child_process";
import { detectShell } from "../tools/bash.js";
import { loadConfig, DEFAULT_MODEL } from "../config/config.js";
import { GLOBAL_CONFIG_FILE, projectSettingsFile, sessionsDir } from "../config/paths.js";
import { PROVIDERS, resolveApiKey } from "../providers/registry.js";
import { SessionStore } from "../session/store.js";
import { VERSION } from "../version.js";

const ok = (s: string) => `  ✓ ${s}`;
const warn = (s: string) => `  ! ${s}`;
const info = (s: string) => `  · ${s}`;

/** `aerin doctor` — environment diagnostics for bug reports and setup help. */
export async function runDoctor(cwd: string): Promise<void> {
  const lines: string[] = [];
  lines.push(`aerin ${VERSION} on ${process.platform} (node ${process.version})`);

  const shell = detectShell();
  lines.push("", "Shell for the bash tool:");
  lines.push(ok(`${shell.kind}: ${shell.path}`));
  if (shell.kind === "powershell") {
    lines.push(warn("no bash found — install Git for Windows for a much better agent experience"));
  }

  const { findRipgrep } = await import("../tools/search-tools.js");
  const rgBin = await findRipgrep();
  lines.push("", "Search:");
  lines.push(
    rgBin
      ? ok(`ripgrep: ${rgBin === "rg" ? "on PATH" : rgBin}`)
      : warn(
          "ripgrep not found (PATH or VS Code) — grep uses a slower JS fallback. Install: winget install BurntSushi.ripgrep.MSVC",
        ),
  );

  const { findEvery, EVERY_INSTALL_HINT } = await import("../tools/schedule-tool.js");
  const everyBin = findEvery();
  const everyVersion = spawnSync(everyBin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  lines.push("", "Scheduler (schedule tool):");
  lines.push(
    everyVersion.status === 0
      ? ok(`${everyVersion.stdout.trim().split("\n")[0]}: ${everyBin === "every" ? "on PATH" : everyBin}`)
      : warn(`every not found — recurring tasks need it (aerin never uses cron). Install: ${EVERY_INSTALL_HINT}`),
  );

  const { discoverSkills } = await import("../core/skills.js");
  const { discoverCommands } = await import("../core/commands.js");
  const skills = await discoverSkills(cwd);
  const commands = await discoverCommands(cwd);
  lines.push("", "Extensions:");
  lines.push(info(`skills: ${skills.length ? skills.map((s) => s.name).join(", ") : "(none — .aerin/skills/<name>/SKILL.md)"}`));
  lines.push(info(`commands: ${commands.length ? commands.map((c) => "/" + c.name).join(", ") : "(none — .aerin/commands/<name>.md)"}`));

  try {
    const res = await fetch("https://registry.npmjs.org/aerin-agent/latest", { signal: AbortSignal.timeout(4000) });
    const latest = res.ok ? ((await res.json()) as { version?: string }).version : undefined;
    lines.push("", "Version:");
    lines.push(
      latest && latest !== VERSION
        ? warn(`v${VERSION} — v${latest} available (aerin update)`)
        : ok(`v${VERSION} is the latest`),
    );
  } catch {
    // offline — skip
  }

  lines.push("", "Config:");
  lines.push(info(`global:  ${GLOBAL_CONFIG_FILE} ${fs.existsSync(GLOBAL_CONFIG_FILE) ? "(exists)" : "(none)"}`));
  const projFile = projectSettingsFile(cwd);
  lines.push(info(`project: ${projFile} ${fs.existsSync(projFile) ? "(exists)" : "(none)"}`));

  let configOk = true;
  try {
    const { config } = await loadConfig(cwd);
    lines.push(info(`default model: ${config.model ?? DEFAULT_MODEL}${config.model ? "" : " (built-in default)"}`));

    lines.push("", "Providers:");
    for (const [id, meta] of Object.entries(PROVIDERS)) {
      if (!meta.needsKey) {
        lines.push(info(`${meta.name}: no key needed (local)`));
        continue;
      }
      const key = resolveApiKey(id, config);
      lines.push(
        key
          ? ok(`${meta.name}: key found (${key.slice(0, 6)}…, ${key.length} chars)`)
          : info(`${meta.name}: no key (${meta.envVar})`),
      );
    }

    const mcpNames = Object.keys(config.mcpServers ?? {});
    lines.push("", "MCP servers:");
    lines.push(mcpNames.length ? info(mcpNames.join(", ")) : info("(none configured)"));
  } catch (err) {
    configOk = false;
    lines.push(warn(`config error: ${err instanceof Error ? err.message : err}`));
  }

  const sessions = await SessionStore.list(cwd).catch(() => []);
  lines.push("", "Sessions:");
  lines.push(info(`${sessions.length} in ${sessionsDir(cwd)}`));

  stdout.write(lines.join("\n") + "\n");
  if (!configOk) process.exitCode = 1;
}
