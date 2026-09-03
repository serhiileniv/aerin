import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { C } from "../theme.js";

/** Terminal height at render time (undefined when not a TTY). */
function stdoutRows(): number | undefined {
  return process.stdout.rows;
}

export interface CommandSuggestion {
  name: string;
  description: string;
}

/**
 * Text input with cursor movement, editing (backspace, Ctrl+U clear, Ctrl+W
 * delete word), and Up/Down history recall. Multi-line drafts are supported:
 * pasted newlines are preserved, "\"+Enter or Alt+Enter insert a newline, and
 * Up/Down move between lines while the draft is multi-line.
 *
 * When `commands` is provided and the value is a bare "/prefix", a live
 * suggestion list appears: ↑/↓ select, Tab completes, Enter runs. An "@token"
 * at the cursor completes workspace file paths the same way.
 */
export function LineInput(props: {
  prompt: string;
  onSubmit: (value: string) => void;
  active: boolean;
  history?: readonly string[];
  commands?: readonly CommandSuggestion[];
  /** Workspace file paths for @-mention completion. */
  files?: readonly string[];
  /** Dim hint shown while the input is empty. */
  placeholder?: string;
  /** When true, Esc clears the draft; a second Esc within 600ms recalls the last message. */
  escActive?: boolean;
  /** Supplier of the last submitted message for double-Esc recall. */
  recallLast?: () => string | undefined;
  /** Scroll the transcript (+1 back / -1 forward) — receives wheel-as-arrow bursts. */
  onScroll?: (dir: number) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1); // -1 = editing a fresh line
  const [draft, setDraft] = useState("");
  const [suggIdx, setSuggIdx] = useState(0);
  const lastEsc = React.useRef(0);
  // Wheel-as-arrows guard: terminals/tmux that translate the mouse wheel into
  // arrow keys in the alt screen send them in rapid bursts. A lone arrow is
  // held ~35ms — if more arrive in the window it was a wheel notch and every
  // arrow becomes a transcript scroll step; only a genuinely lone keypress
  // recalls input history. Scrolling can never summon old prompts.
  const arrowBurst = React.useRef<{ last: number; pendingUp: boolean; timer: ReturnType<typeof setTimeout> | null }>({
    last: 0,
    pendingUp: false,
    timer: null,
  });
  useEffect(
    () => () => {
      if (arrowBurst.current.timer) clearTimeout(arrowBurst.current.timer);
    },
    [],
  );

  const set = (v: string, c: number) => {
    setValue(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
  };

  const suggesting = (props.commands?.length ?? 0) > 0 && value.startsWith("/") && !value.includes(" ");
  const matches = suggesting
    ? (props.commands ?? []).filter((c) => c.name.startsWith(value.toLowerCase()))
    : [];
  const cSugg = Math.min(suggIdx, Math.max(0, matches.length - 1));

  // "@partial" at the cursor → file-path completion.
  const atMatch = /@([^\s@]*)$/.exec(value.slice(0, cursor));
  const fileMatches =
    atMatch && (props.files?.length ?? 0) > 0 && !suggesting
      ? (props.files ?? [])
          .filter((f) => fuzzyMatch((atMatch[1] ?? "").toLowerCase(), f.toLowerCase()))
          .slice(0, 8)
      : [];
  const cFile = Math.min(suggIdx, Math.max(0, fileMatches.length - 1));

  const completeFile = (): void => {
    const f = fileMatches[cFile];
    if (!f || !atMatch) return;
    const start = cursor - atMatch[0].length;
    const next = value.slice(0, start) + "@" + f + " " + value.slice(cursor);
    set(next, start + f.length + 2);
    setSuggIdx(0);
  };

  useInput(
    (input, key) => {
      const history = props.history ?? [];
      // Esc clears the draft; Esc-Esc (600ms) recalls the last message to edit.
      if (key.escape && props.escActive) {
        const now = Date.now();
        if (value) {
          set("", 0);
          setSuggIdx(0);
          lastEsc.current = now;
        } else if (now - lastEsc.current < 600) {
          const last = props.recallLast?.();
          if (last) set(last, last.length);
          lastEsc.current = 0;
        } else {
          lastEsc.current = now;
        }
        return;
      }
      if (fileMatches.length > 0 && atMatch && atMatch[0].length > 1) {
        if (key.upArrow) return setSuggIdx(Math.max(0, cFile - 1));
        if (key.downArrow) return setSuggIdx(Math.min(fileMatches.length - 1, cFile + 1));
        if ((key.tab && !key.shift) || key.return) return completeFile();
      }
      if (matches.length > 0) {
        if (key.upArrow) return setSuggIdx(Math.max(0, cSugg - 1));
        if (key.downArrow) return setSuggIdx(Math.min(matches.length - 1, cSugg + 1));
        if (key.tab && !key.shift) {
          const m = matches[cSugg];
          if (m) set(m.name, m.name.length);
          setSuggIdx(0);
          return;
        }
        if (key.return) {
          const m = matches[cSugg];
          set("", 0);
          setSuggIdx(0);
          setHistIdx(-1);
          props.onSubmit(m ? m.name : value);
          return;
        }
      }
      if (key.return) {
        // Alt+Enter always inserts a newline; a trailing "\" continues the line.
        if (key.meta) {
          set(value.slice(0, cursor) + "\n" + value.slice(cursor), cursor + 1);
          return;
        }
        if (value.slice(0, cursor).endsWith("\\")) {
          set(value.slice(0, cursor - 1) + "\n" + value.slice(cursor), cursor);
          return;
        }
        const v = value;
        set("", 0);
        setHistIdx(-1);
        setDraft("");
        props.onSubmit(v);
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      // In a multi-line draft, up/down move between lines; otherwise history.
      if (value.includes("\n") && (key.upArrow || key.downArrow)) {
        const lines = value.split("\n");
        let line = 0;
        let col = cursor;
        for (const l of lines) {
          if (col <= l.length) break;
          col -= l.length + 1;
          line++;
        }
        const target = key.upArrow ? line - 1 : line + 1;
        if (target < 0 || target >= lines.length) return;
        let pos = 0;
        for (let i = 0; i < target; i++) pos += (lines[i]?.length ?? 0) + 1;
        setCursor(pos + Math.min(col, lines[target]?.length ?? 0));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const dirUp = Boolean(key.upArrow);
        const applyHistory = (up: boolean): void => {
          if (up) {
            if (history.length === 0) return;
            if (histIdx === -1) setDraft(value);
            const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
            setHistIdx(next);
            set(history[next] ?? "", (history[next] ?? "").length);
          } else {
            if (histIdx === -1) return;
            if (histIdx >= history.length - 1) {
              setHistIdx(-1);
              set(draft, draft.length);
            } else {
              const next = histIdx + 1;
              setHistIdx(next);
              set(history[next] ?? "", (history[next] ?? "").length);
            }
          }
        };
        if (!props.onScroll) return applyHistory(dirUp); // no scroll target — no hold latency
        const st = arrowBurst.current;
        const now = Date.now();
        const isBurst = st.timer !== null || now - st.last < 35;
        st.last = now;
        if (isBurst) {
          if (st.timer) {
            // The held first arrow of the burst was a scroll step too.
            clearTimeout(st.timer);
            st.timer = null;
            props.onScroll(st.pendingUp ? 1 : -1);
          }
          props.onScroll(dirUp ? 1 : -1);
          return;
        }
        st.pendingUp = dirUp;
        st.timer = setTimeout(() => {
          st.timer = null;
          applyHistory(dirUp);
        }, 35);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.ctrl) {
        if (input === "a") return setCursor(0); // also sent by Home
        if (input === "e") return setCursor(value.length); // also sent by End
        if (input === "b") {
          // word left (also sent by Ctrl+←)
          const head = value.slice(0, cursor);
          const m = /\S+\s*$/.exec(head);
          return setCursor(m ? head.length - m[0].length : 0);
        }
        if (input === "f") {
          // word right (also sent by Ctrl+→)
          const tail = value.slice(cursor);
          const m = /^\s*\S+/.exec(tail);
          return setCursor(cursor + (m ? m[0].length : tail.length));
        }
        if (input === "u") return set("", 0);
        if (input === "w") {
          const head = value.slice(0, cursor).replace(/\S+\s*$/, "");
          set(head + value.slice(cursor), head.length);
          return;
        }
        return;
      }
      if (input && !key.meta) {
        const clean = input.replace(/\r\n?/g, "\n"); // pasted newlines are preserved
        set(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
        setHistIdx(-1);
        setSuggIdx(0);
      }
    },
    { isActive: props.active },
  );

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  const pad = Math.max(...matches.map((m) => m.name.length), 0) + 2;

  // Suggestions render ABOVE the input row (Claude Code-style): the input is
  // pinned to the bottom of the screen, so anything below it would be clipped
  // into the bar; above, the list pushes the transcript up and stays visible.
  return (
    <Box flexDirection="column">
      {matches.map((m, i) => (
        <Text
          key={m.name}
          backgroundColor={i === cSugg ? C.accent : undefined}
          color={i === cSugg ? "#000000" : C.dim}
        >
          {i === cSugg ? "❯ " : "  "}
          {m.name.padEnd(pad)}
          {m.description}
          {"  "}
        </Text>
      ))}
      {atMatch && atMatch[0].length > 1
        ? fileMatches.map((f, i) => (
            <Text
              key={f}
              backgroundColor={i === cFile ? C.accent : undefined}
              color={i === cFile ? "#000000" : C.dim}
            >
              {i === cFile ? "❯ " : "  "}@{f}{"  "}
            </Text>
          ))
        : null}
      <Box>
        <Text color={C.dim}>{props.prompt}</Text>
        {!value && props.placeholder ? (
          <>
            {props.active ? (
              <Text backgroundColor={C.accentBright} color="#000000">
                {props.placeholder[0] ?? " "}
              </Text>
            ) : null}
            <Text color={C.dim} dimColor>
              {props.active ? props.placeholder.slice(1) : props.placeholder}
            </Text>
          </>
        ) : (
          <>
            <Text>{before}</Text>
            {props.active ? (
              <Text backgroundColor={C.accentBright} color="#000000">
                {at}
              </Text>
            ) : (
              <Text>{at}</Text>
            )}
            <Text>{after}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(props: { label: string; since?: number }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(t);
  }, []);
  const elapsed = props.since ? Math.floor((Date.now() - props.since) / 1000) : 0;
  return (
    <Text color={C.dim}>
      {/* Neon pulse: the glyph flickers pink ↔ synth purple. */}
      <Text color={frame % 2 === 0 ? C.accentBright : C.magenta}>{SPINNER_FRAMES[frame]}</Text> {props.label}
      {elapsed > 0 ? ` · ${elapsed}s` : ""}
    </Text>
  );
}

/** Unified-diff renderer: green additions, red deletions, cyan hunk headers. */
export function DiffText(props: { diff: string; maxLines?: number }): React.ReactElement {
  const lines = props.diff.split("\n").slice(0, props.maxLines ?? 30);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text
          key={i}
          color={
            line.startsWith("+") && !line.startsWith("+++")
              ? C.ok
              : line.startsWith("-") && !line.startsWith("---")
                ? C.error
                : line.startsWith("@@")
                  ? C.accent
                  : C.dim
          }
        >
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

export interface SelectItem {
  label: string;
  value: string;
  /** Non-selectable section header (e.g. a provider name). */
  header?: boolean;
}

const FILTER_VISIBLE_ROWS = 14;

/** Substring match, falling back to in-order subsequence ("gpt4m" → "gpt-4o-mini"). */
function fuzzyMatch(query: string, label: string): boolean {
  if (label.includes(query)) return true;
  let i = 0;
  for (const ch of label) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return i === query.length;
}

/**
 * Filterable select with section headers: type to narrow, arrows move over
 * selectable rows only, Enter picks, Esc cancels. Headers survive filtering
 * only while they still have visible children. A sliding window keeps
 * hundreds of items (e.g. OpenRouter's model list) usable in a terminal.
 */
export function FilterSelect(props: {
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  active: boolean;
  placeholder?: string;
  /** Mouse wheel emitter (-1 up / +1 down) — scrolls the selection. */
  wheel?: { on: (e: "wheel", fn: (dir: number) => void) => unknown; off: (e: "wheel", fn: (dir: number) => void) => unknown };
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0); // index into the selectable subset

  const q = query.toLowerCase();
  const rows: SelectItem[] = [];
  for (let i = 0; i < props.items.length; i++) {
    const it = props.items[i];
    if (!it) continue;
    if (it.header) {
      for (let j = i + 1; j < props.items.length; j++) {
        const child = props.items[j];
        if (!child || child.header) break;
        if (!q || fuzzyMatch(q, child.label.toLowerCase())) {
          rows.push(it);
          break;
        }
      }
    } else if (!q || fuzzyMatch(q, it.label.toLowerCase())) {
      rows.push(it);
    }
  }
  const selectableRowIdx = rows.flatMap((r, i) => (r.header ? [] : [i]));
  const clampedSel = Math.min(sel, Math.max(0, selectableRowIdx.length - 1));
  const currentRow = selectableRowIdx[clampedSel] ?? -1;

  // Mouse wheel moves the selection like the arrow keys.
  const selectableCountRef = React.useRef(0);
  selectableCountRef.current = selectableRowIdx.length;
  useEffect(() => {
    const w = props.wheel;
    if (!w || !props.active) return;
    const onWheel = (dir: number): void => {
      setSel((s) => Math.max(0, Math.min(selectableCountRef.current - 1, s + dir)));
    };
    w.on("wheel", onWheel);
    return () => {
      w.off("wheel", onWheel);
    };
  }, [props.wheel, props.active]);

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.return) {
        const item = rows[currentRow];
        if (item) props.onSelect(item.value);
        return;
      }
      if (key.upArrow) return setSel(Math.max(0, clampedSel - 1));
      if (key.downArrow) return setSel(Math.min(selectableRowIdx.length - 1, clampedSel + 1));
      if (key.backspace || key.delete) {
        setQuery((v) => v.slice(0, -1));
        setSel(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((v) => v + input.replace(/\r?\n/g, ""));
        setSel(0);
      }
    },
    { isActive: props.active },
  );

  // Clamp to the window: if the picker frame ever reaches the terminal
  // height, Ink falls into its clear-terminal-per-frame path (screen wipe +
  // full transcript reprint every frame).
  const visibleRows = Math.max(4, Math.min(FILTER_VISIBLE_ROWS, (stdoutRows() ?? 24) - 8));
  const anchor = currentRow >= 0 ? currentRow : 0;
  const windowStart = Math.max(0, Math.min(anchor - 6, rows.length - visibleRows));
  const visible = rows.slice(windowStart, windowStart + visibleRows);
  const selectableCount = selectableRowIdx.length;
  const totalSelectable = props.items.filter((i) => !i.header).length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.accent}>filter: </Text>
        <Text>{query || (props.placeholder ?? "type to filter…")}</Text>
        <Text color={C.dim}> ({selectableCount}/{totalSelectable})</Text>
      </Box>
      {visible.map((item, i) => {
        const absolute = windowStart + i;
        if (item.header) {
          return (
            <Text key={`h-${item.value}`} bold color={C.magenta}>
              {item.label}
            </Text>
          );
        }
        return (
          <Text key={item.value} color={absolute === currentRow ? C.accent : undefined}>
            {absolute === currentRow ? "❯ " : "  "}
            {item.label}
          </Text>
        );
      })}
      {selectableCount === 0 ? <Text color={C.dim}>  (no matches — Esc to cancel)</Text> : null}
    </Box>
  );
}

/** Minimal arrow-key select list. */
export function SelectList(props: {
  items: SelectItem[];
  onSelect: (value: string) => void;
  active: boolean;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  useInput(
    (_input, key) => {
      if (key.upArrow) setIndex((i) => (i - 1 + props.items.length) % props.items.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % props.items.length);
      else if (key.return) {
        const item = props.items[index];
        if (item) props.onSelect(item.value);
      }
    },
    { isActive: props.active },
  );
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <Text key={item.value} color={i === index ? C.accent : undefined}>
          {i === index ? "❯ " : "  "}
          {item.label}
        </Text>
      ))}
    </Box>
  );
}
