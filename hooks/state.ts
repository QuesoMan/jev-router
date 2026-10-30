/**
 * What Jev is shown: the state of one routing question, as named fields.
 *
 * TypeSafe reads a JSON object as named parts, which a run of text with
 * headers in it is not, and every field here is one a person deciding
 * "which model, thinking how hard" would look at. Nothing else goes in:
 * a field added for its own sake can sway the answer, and an empty list is
 * itself a signal, so a field with nothing to say is left out entirely
 * rather than sent empty.
 *
 * A main-loop turn (`turnStateOf`):
 *
 *   request              what the developer typed, or a notification's
 *                        summary on a turn a finished background task woke
 *   recent_conversation  the last few things the developer and the agent
 *                        said to each other before it, oldest first
 *   files_in_play        the files the agent has lately been reading and
 *                        editing, newest first
 *   continuing           true when the request follows earlier turns of
 *                        the session
 *
 * A request typed to a coding agent is short and leans on what came before
 * ("do the same for the other two", "ok ship it"): on its own it fails the
 * human test, since nobody can tell from "do it" whether "it" is a rename or
 * a migration. The last exchange says what "it" is, and the files say what
 * it touches. `continuing` says there was an earlier exchange even when none
 * of it is shown (compacted away, or nothing but tool calls), so a bare
 * "yes" reads as an answer, not as a whole request.
 *
 * A subagent's or workflow agent's task (`briefStateOf`):
 *
 *   brief           the prompt its caller wrote, the whole task
 *   task            the caller's short description of it
 *   agent_type      the kind of agent (`general-purpose`, `Explore`)
 *   from_workflow   true when a Workflow script's `agent()` started it
 *   parent_request  what the developer last typed to the main loop, only
 *                   when the brief is thin
 *
 * A brief is written to be carried out alone, so it usually says all there
 * is to say; the developer's request would only be a second account of the
 * same work, and one written before the agent split it up. It earns its
 * place when the brief says too little to judge (a one-line "review the
 * diff"), which is what `THIN_BRIEF_CHARS` stands for.
 *
 * The budget. Every field has its own cap, and the whole serialized state
 * has one more, `STATE_BUDGET`. Context costs twice: every character is
 * paid for and waited on before the turn can start, and a long context
 * dilutes the one thing that matters, the request itself, with history
 * that is mostly about something else (context rot). So the conversation is
 * a few short messages, the files at most ten paths, and when the whole
 * still runs over, what goes first is what matters least: the oldest
 * conversation, then the oldest files, and only then the middle of the
 * request or brief, which keeps its head (what to do) and its tail (what
 * to hand back).
 *
 * Pure, and free of engine types: `register.ts` reads the transcript and
 * the directory and hands them in as plain data, so this runs under node.
 */

import {
  ENVELOPE_PREAMBLE,
  FOOTER_SEPARATOR,
  NOTIFICATION,
  REPLY_SEPARATOR,
} from "./status.ts";

/** Who said a line of the conversation, in the words the question uses. */
export type Speaker = "developer" | "agent";

/** One message of the conversation as Jev is shown it. */
export type Line = { from: Speaker; text: string };

/** The state of a main-loop turn's question. */
export type TurnState = {
  request: string;
  recent_conversation?: Line[];
  files_in_play?: string[];
  continuing?: true;
};

/** The state of a subagent's or workflow agent's question. */
export type BriefState = {
  /** Absent only when the spawn carried no prompt at all. */
  brief?: string;
  task?: string;
  agent_type?: string;
  from_workflow?: true;
  parent_request?: string;
};

/**
 * One tool call of a transcript row, as far as this file reads it: which
 * tool, its arguments, and whether it failed. The shape of the engine's
 * `ToolUseSummary`, narrowed.
 */
export type ToolUseRow = {
  tool: string;
  input: Readonly<Record<string, unknown>>;
  isError?: boolean;
};

/**
 * One message of the transcript, as far as this file reads it: the shape of
 * the engine's `SessionMessage`, narrowed, so a test can write one out.
 */
export type TranscriptRow = {
  role: string;
  text: string;
  toolUses?: readonly ToolUseRow[];
  toolResults?: readonly unknown[];
};

/**
 * The most the serialized state may run to, in characters of its JSON.
 *
 * Half the brief cap the state had when it was text (8000): a brief's
 * shape, which is what difficulty is read from, survives a cut to a head
 * and a tail of 2000 each, and the fields beside it are capped far below
 * this, so in practice only a pasted file or a long log ever reaches it.
 */
export const STATE_BUDGET = 4000;

/** The most messages of the conversation shown. */
export const MAX_CONVERSATION_MESSAGES = 4;

/** The most characters of the conversation shown, all messages together. */
export const MAX_CONVERSATION_CHARS = 1600;

/** The most characters of one message, its head kept. */
export const MAX_MESSAGE_CHARS = 400;

/** The most files shown. */
export const MAX_FILES = 10;

/**
 * How many of the newest transcript rows the files are read from. "In play"
 * is lately: a file read two hours ago in another part of the work says
 * nothing about this request.
 */
export const FILE_LOOKBACK_ROWS = 50;

/** A brief shorter than this gets the developer's request beside it. */
export const THIN_BRIEF_CHARS = 400;

/** The most characters of the developer's request shown beside a brief. */
export const MAX_PARENT_REQUEST_CHARS = 300;

/** Caps on the brief's header fields, so a runaway one cannot crowd it out. */
const MAX_TYPE_CHARS = 100;
const MAX_TASK_CHARS = 300;

/** The tools whose arguments name a file, and the argument that does. */
const FILE_ARGS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  // A search's `path` is usually a directory; it counts only when it names
  // a file (`isFilePath`).
  Glob: ["path"],
  Grep: ["path"],
};

/** The tools whose `path` may be a directory, which is no file in play. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep"]);

/**
 * The summary a compaction leaves in the user's turn. Nobody typed it, but
 * it does say there were earlier turns (`hasEarlierTurns`).
 */
const CONTINUED = /^This session is being continued from a previous conversation/;

/**
 * Envelopes the engine and the harness deliver into the main loop's turn
 * from someone other than the developer: a background task's notification
 * (`NOTIFICATION`, shared with the row's reading of it), a teammate's or
 * another session's message, a channel's. Each may come after a bracketed
 * label on its own line (`ENVELOPE_PREAMBLE`). What is inside is another
 * party's words, which would read as the developer's, payload and all.
 */
const ENVELOPES: readonly RegExp[] = [
  NOTIFICATION,
  new RegExp(
    `${ENVELOPE_PREAMBLE}<(?:teammate-message|cross-session-message|channel|task-notification)[\\s>]`,
  ),
];

/**
 * User messages nobody typed: what the engine and the harness put in the
 * user's turn. A slash command and its output, a hook's note, a loaded
 * skill's instructions, an envelope from another party (`ENVELOPES`), the
 * summary a compaction left, an interruption. None of them is the
 * developer talking, and each would read as if it were.
 *
 * The transcript marks none of them (a `SessionMessage` has no meta flag),
 * so they are known by how they open, which is the engine's framing and
 * stable; a framing missing here shows up as one stray line of context,
 * never as a wrong route by itself.
 */
const META_OPENINGS: readonly RegExp[] = [
  ...ENVELOPES,
  /^<command-(name|message|args)>/,
  /^<local-command-(stdout|stderr|caveat)>/,
  /^<user-prompt-submit-hook>/,
  /^<bash-(input|stdout|stderr)>/,
  /^Caveat: The messages below were generated by the user while running local commands/,
  /^Base directory for this skill:/,
  CONTINUED,
  /^\[Request interrupted by user/,
];

/**
 * Whether a user message's text is one nobody typed (`META_OPENINGS`),
 * read as `lineOf` reads it: the engine's reminders off first. What the
 * router keeps as the developer's latest request goes by this too, so a
 * teammate's envelope is never shown beside a brief as theirs.
 */
export function isEngineText(text: string): boolean {
  const said = text.replace(REMINDER, "").trim();
  return META_OPENINGS.some((meta) => meta.test(said));
}

/** Reminders the engine adds as text blocks of a user message. */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * The route line the router opens each reply with, and the rule under it.
 * It is in the recorded text of every reply it announced, and showing Jev
 * its own last pick beside the request would only invite it to repeat it.
 */
const ROUTE_LINE = new RegExp(
  `^> (?:✳️|⚠️) \`[^\`\\n]*\`[^\\n]*${escaped(REPLY_SEPARATOR)}`,
);

/** The usage footer at the end of a reply, fenced, for the same reason. */
const FOOTER = new RegExp(
  `${escaped(FOOTER_SEPARATOR)}\`\`\`\\n─+\\njev  [^\\n]*\\napi  [^\\n]*\\n\`\`\`\\s*$`,
);

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Runs of whitespace as one space, ends trimmed: a message as one line. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text` cut to its first `max` characters, the cut marked. */
export function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function markerOf(count: number): string {
  return `[… ${count} chars elided …]`;
}

/**
 * `text` cut to at most `max` characters by dropping its middle.
 *
 * The head usually says what the task is and the tail what to hand back
 * and when to stop, so both are kept, and the marker says how much went
 * missing between them rather than letting the cut pass for the end.
 */
export function elided(text: string, max: number): string {
  if (text.length <= max) return text;
  // Sized for the most digits the count could need, so the real marker
  // never pushes the result past `max`. Two more for the newlines round it.
  const room = max - markerOf(text.length).length - 2;
  if (room <= 0) return text.slice(0, Math.max(0, max));
  const head = Math.ceil(room / 2);
  const tail = room - head;
  const cut = text.length - head - tail;
  return (
    text.slice(0, head) +
    "\n" +
    markerOf(cut) +
    "\n" +
    text.slice(text.length - tail)
  );
}

/**
 * What a transcript row says, as a line of the conversation, or null when
 * it is no part of one: a tool call or a tool's result, a message with no
 * text, and the user messages nobody typed (`META_OPENINGS`).
 *
 * An assistant row that made tool calls is left out with them: its text is
 * the narration between calls ("Let me read the file."), and the agent's
 * actual reply is the row that ends its turn, which makes none. The
 * router's own route line and footer come off a reply first, and the
 * engine's reminders off a user message.
 */
export function lineOf(row: TranscriptRow): Line | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  if ((row.toolUses?.length ?? 0) > 0) return null;
  if ((row.toolResults?.length ?? 0) > 0) return null;
  if (typeof row.text !== "string") return null;

  let text = row.text;
  if (row.role === "user") {
    text = text.replace(REMINDER, "").trim();
    if (META_OPENINGS.some((meta) => meta.test(text))) return null;
  } else {
    text = text.replace(ROUTE_LINE, "").replace(FOOTER, "");
  }
  const said = flat(text);
  if (said === "") return null;
  return {
    from: row.role === "user" ? "developer" : "agent",
    text: headOf(said, MAX_MESSAGE_CHARS),
  };
}

/**
 * The rows before the current request: the transcript cut at the request's
 * own message when it is the newest thing said, with nothing after it but
 * rows that are no part of the conversation (a reminder, a hook's note).
 * Whether the engine has added the turn's own message by `turn.start` is
 * its business; either way the request is shown once, as `request`.
 */
function before(
  rows: readonly TranscriptRow[],
  request: string,
): readonly TranscriptRow[] {
  const said = flat(request);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (
      row.role === "user" &&
      typeof row.text === "string" &&
      flat(row.text.replace(REMINDER, "")) === said
    ) {
      return rows.slice(0, i);
    }
    if (lineOf(row) !== null) break;
  }
  return rows;
}

/**
 * The last few lines of the conversation before the request, oldest first:
 * at most `MAX_CONVERSATION_MESSAGES` of them and `MAX_CONVERSATION_CHARS`
 * between them, the oldest dropped first. A line that would not fit whole
 * is dropped, not cut further: each is already cut to its head.
 */
export function recentConversationOf(
  rows: readonly TranscriptRow[],
  request: string,
): Line[] {
  const lines: Line[] = [];
  let chars = 0;
  const earlier = before(rows, request);
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (lines.length >= MAX_CONVERSATION_MESSAGES) break;
    const line = lineOf(earlier[i]!);
    if (line === null) continue;
    if (chars + line.text.length > MAX_CONVERSATION_CHARS) break;
    chars += line.text.length;
    lines.unshift(line);
  }
  return lines;
}

/** A path with forward slashes, which reads the same on every system. */
function slashed(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Whether a path names a file rather than a directory, read from its last
 * segment alone, since nothing here can look at the disk: a name with an
 * extension (`net.test.ts`, `.env.local`) and no glob in it. A dotted
 * directory (`.github`) does not count, and is in no way a file in play. A search
 * scoped to `src` or `hooks/` is about a directory and says nothing about
 * which file is in play.
 */
export function isFilePath(path: string): boolean {
  const name = slashed(path).replace(/\/+$/, "").split("/").at(-1) ?? "";
  if (name === "" || /[*?[\]{}]/.test(name)) return false;
  return /.\.[A-Za-z0-9_-]+$/.test(name);
}

/**
 * A path as Jev is shown it: relative to `cwd` when it lies under it,
 * forward slashes either way. A Windows directory is compared without
 * regard to case, as Windows compares it.
 */
export function relativePath(path: string, cwd?: string): string {
  const file = slashed(path);
  if (cwd === undefined || cwd.trim() === "") return file;
  const root = slashed(cwd).replace(/\/+$/, "");
  const windows = /^[A-Za-z]:/.test(root);
  const same = (a: string, b: string) =>
    windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  const prefix = `${root}/`;
  if (same(file.slice(0, prefix.length), prefix)) {
    return file.slice(prefix.length);
  }
  return file;
}

/**
 * The files the agent has lately been reading and editing, newest first,
 * each once, at most `MAX_FILES`, from the tool calls of the newest
 * `FILE_LOOKBACK_ROWS` rows. A call that failed is skipped: a Read of a
 * file that is not there puts nothing in play.
 */
export function filesInPlayOf(
  rows: readonly TranscriptRow[],
  cwd?: string,
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const recent = rows.slice(-FILE_LOOKBACK_ROWS);
  for (let i = recent.length - 1; i >= 0 && files.length < MAX_FILES; i--) {
    const uses = recent[i]!.toolUses ?? [];
    for (let j = uses.length - 1; j >= 0 && files.length < MAX_FILES; j--) {
      const use = uses[j]!;
      if (use.isError) continue;
      for (const arg of FILE_ARGS[use.tool] ?? []) {
        const raw = use.input?.[arg];
        if (typeof raw !== "string" || raw.trim() === "") continue;
        if (SEARCH_TOOLS.has(use.tool) && !isFilePath(raw)) continue;
        const file = relativePath(raw.trim(), cwd);
        const key = /^[A-Za-z]:/.test(slashed(cwd ?? "")) ? file.toLowerCase() : file;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(file);
      }
    }
  }
  return files;
}

/**
 * Whether the request follows an earlier exchange of the session: a line
 * of the conversation before it, a tool call the agent made, or the summary
 * a compaction left of turns no longer shown. A slash command's rows, a
 * reminder or a notification before the first thing the developer typed
 * are no exchange, and the request they come before is still the first.
 */
function hasEarlierTurns(
  rows: readonly TranscriptRow[],
  request: string,
): boolean {
  return before(rows, request).some(
    (row) =>
      lineOf(row) !== null ||
      (row.role === "assistant" && (row.toolUses?.length ?? 0) > 0) ||
      (row.role === "user" &&
        typeof row.text === "string" &&
        CONTINUED.test(row.text.replace(REMINDER, "").trim())),
  );
}

/**
 * What the developer last said to the main loop, as the transcript has it,
 * or null when it has nothing they typed. The router keeps the latest typed
 * request as each turn starts; this is where it finds it again when the
 * module was reloaded since, so a thin brief still gets it.
 */
export function lastTypedRequestOf(
  rows: readonly TranscriptRow[],
): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = lineOf(rows[i]!);
    if (line?.from === "developer") return line.text;
  }
  return null;
}

/** The length of a state as it is sent. */
export function sizeOf(state: object): number {
  return JSON.stringify(state).length;
}

/**
 * A turn's state held to `budget`: the oldest conversation dropped first,
 * then the oldest files, then the request's middle elided to what is left.
 */
export function budgetedTurn(
  state: TurnState,
  budget: number = STATE_BUDGET,
): TurnState {
  let conversation = state.recent_conversation ?? [];
  let files = state.files_in_play ?? [];
  const assembled = () =>
    turnOf(state.request, conversation, files, state.continuing === true);
  let out = assembled();
  while (sizeOf(out) > budget && conversation.length > 0) {
    conversation = conversation.slice(1);
    out = assembled();
  }
  while (sizeOf(out) > budget && files.length > 0) {
    files = files.slice(0, -1);
    out = assembled();
  }
  const over = sizeOf(out) - budget;
  if (over > 0) out = { ...out, request: fitted(out.request, over) };
  return out;
}

/**
 * A brief's state held to `budget`. Its context fields are few and short,
 * so what gives is the brief's middle; the developer's request goes first
 * should a caller ever send it beside a brief that needs the room.
 */
export function budgetedBrief(
  state: BriefState,
  budget: number = STATE_BUDGET,
): BriefState {
  let out: BriefState = { ...state };
  if (sizeOf(out) > budget && out.parent_request !== undefined) {
    const { parent_request: _, ...rest } = out;
    out = rest;
  }
  const over = sizeOf(out) - budget;
  if (over > 0 && out.brief !== undefined) {
    out = { ...out, brief: fitted(out.brief, over) };
  }
  return out;
}

/**
 * `text` elided until its serialized form is `over` characters shorter at
 * least: the longest cut that fits. JSON escapes make serialized text
 * longer than the text (a newline is two characters, a quote two), so the
 * cut is measured serialized, and found by halving rather than guessed.
 */
function fitted(text: string, over: number): string {
  const serialized = (s: string) => JSON.stringify(s).length;
  const target = serialized(text) - over;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serialized(elided(text, mid)) <= target) lo = mid;
    else hi = mid - 1;
  }
  return elided(text, lo);
}

/**
 * A turn's state from its parts, in the order Jev reads them, each list
 * left out when it is empty.
 */
function turnOf(
  request: string,
  conversation: readonly Line[],
  files: readonly string[],
  continuing: boolean,
): TurnState {
  return {
    request,
    ...(conversation.length > 0
      ? { recent_conversation: [...conversation] }
      : {}),
    ...(files.length > 0 ? { files_in_play: [...files] } : {}),
    ...(continuing ? { continuing: true as const } : {}),
  };
}

/**
 * The state of a main-loop turn's question, from the request and what the
 * session holds: its transcript and the directory it runs in, either of
 * which may be missing, which leaves the fields they feed out.
 *
 * `request` is the text the question is about: what the developer typed,
 * or a notification's summary (the caller reads the envelope).
 */
export function turnStateOf(input: {
  request: string;
  messages?: readonly TranscriptRow[];
  cwd?: string;
}): TurnState {
  const request = input.request.trim();
  const rows = Array.isArray(input.messages) ? input.messages : [];
  const conversation = recentConversationOf(rows, input.request);
  const files = filesInPlayOf(rows, input.cwd);
  return budgetedTurn(
    turnOf(request, conversation, files, hasEarlierTurns(rows, input.request)),
  );
}

/**
 * The state of a subagent's question, from what its spawn says about it
 * and, for a thin brief, the developer's latest request to the main loop.
 * A header field is left out when there is nothing in it.
 */
export function briefStateOf(
  spawn: {
    prompt: string;
    description?: string;
    subagentType?: string;
    workflow?: boolean;
  },
  parentRequest?: string | null,
): BriefState {
  const brief = spawn.prompt.trim();
  const task = spawn.description?.trim();
  const type = spawn.subagentType?.trim();
  const parent = parentRequest?.trim();
  return budgetedBrief({
    ...(brief !== "" ? { brief } : {}),
    ...(task ? { task: elided(task, MAX_TASK_CHARS) } : {}),
    ...(type ? { agent_type: elided(type, MAX_TYPE_CHARS) } : {}),
    ...(spawn.workflow ? { from_workflow: true as const } : {}),
    ...(parent && brief.length < THIN_BRIEF_CHARS
      ? { parent_request: headOf(flat(parent), MAX_PARENT_REQUEST_CHARS) }
      : {}),
  });
}
