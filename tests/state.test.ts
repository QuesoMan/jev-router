import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  briefStateOf,
  budgetedTurn,
  elided,
  filesInPlayOf,
  FILE_LOOKBACK_ROWS,
  isEngineText,
  isFilePath,
  lastTypedRequestOf,
  lineOf,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATION_MESSAGES,
  MAX_FILES,
  MAX_MESSAGE_CHARS,
  MAX_PARENT_REQUEST_CHARS,
  recentConversationOf,
  relativePath,
  sizeOf,
  STATE_BUDGET,
  THIN_BRIEF_CHARS,
  turnStateOf,
  type TranscriptRow,
} from "../hooks/state.ts";
import {
  FOOTER_SEPARATOR,
  liveLine,
  REPLY_SEPARATOR,
  usageFooter,
  type Attempt,
} from "../hooks/status.ts";
import { DEFAULT_LADDER, decisionFor } from "../hooks/policy.ts";

const developer = (text: string): TranscriptRow => ({
  role: "user",
  text,
  toolUses: [],
});
const agent = (text: string): TranscriptRow => ({
  role: "assistant",
  text,
  toolUses: [],
});
const call = (
  tool: string,
  input: Record<string, unknown>,
  text = "",
  isError?: true,
): TranscriptRow => ({
  role: "assistant",
  text,
  toolUses: [{ tool, input, ...(isError ? { isError } : {}) }],
});
const result = (): TranscriptRow => ({
  role: "user",
  text: "",
  toolUses: [],
  toolResults: [{ tool_use_id: "x", text: "file contents", isError: false }],
});

/** A reply as the router records it: the route line on top, the footer under. */
function announced(reply: string): string {
  const attempt: Attempt = {
    prompt: "p",
    ms: 512,
    decision: decisionFor("sonnet", 0.8, "high", DEFAULT_LADDER),
    usage: {
      model: "claude-sonnet-5-5",
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    },
  };
  return (
    `${liveLine(attempt)}${REPLY_SEPARATOR}${reply}` +
    `${FOOTER_SEPARATOR}${usageFooter(attempt)}`
  );
}

/**
 * A session as the engine records it: a first request, the agent reading
 * and editing with narration between calls, the tools' results, a reply
 * the router announced, a slash command, a background task's notification,
 * an interruption, and the current request at the end.
 */
const SESSION: TranscriptRow[] = [
  developer("the upload retries are flaky, can you look"),
  call("Grep", { pattern: "retry", path: "/repo/src" }, "Let me search."),
  result(),
  call("Read", { file_path: "/repo/src/upload.ts" }, "Reading the client."),
  result(),
  call("Read", { file_path: "/repo/src/missing.ts" }, "", true),
  result(),
  call("Edit", { file_path: "/repo/src/upload.ts", old_string: "a" }),
  result(),
  call("Grep", { pattern: "backoff", path: "/repo/src/net.ts" }),
  result(),
  agent(announced("Fixed: the retry loop reused a consumed stream.")),
  developer("<command-name>/jev</command-name><command-args></command-args>"),
  developer("<local-command-stdout>jev-router …</local-command-stdout>"),
  developer(
    "<task-notification><task-id>b7</task-id><summary>Agent done</summary></task-notification>",
  ),
  developer("[Request interrupted by user]"),
  developer("<system-reminder>Context.</system-reminder>"),
  developer("ok now add a test for it"),
];

describe("state: the conversation before a turn", () => {
  test("only what the developer and the agent said, the current request left out", () => {
    assert.deepEqual(recentConversationOf(SESSION, "ok now add a test for it"), [
      { from: "developer", text: "the upload retries are flaky, can you look" },
      {
        from: "agent",
        text: "Fixed: the retry loop reused a consumed stream.",
      },
    ]);
  });

  test("the request is left out only when it is the newest row", () => {
    const rows = [developer("same words"), agent("done")];
    assert.deepEqual(recentConversationOf(rows, "same words"), [
      { from: "developer", text: "same words" },
      { from: "agent", text: "done" },
    ]);
  });

  test("a reminder the engine filed after the request does not hide it", () => {
    const rows = [
      agent("Which file?"),
      developer("the parser"),
      developer("<system-reminder>A file changed.</system-reminder>"),
    ];
    assert.deepEqual(recentConversationOf(rows, "the parser"), [
      { from: "agent", text: "Which file?" },
    ]);
  });

  test("the request is not repeated whether or not the engine added it yet", () => {
    const without = SESSION.slice(0, -1);
    assert.deepEqual(
      recentConversationOf(without, "ok now add a test for it"),
      recentConversationOf(SESSION, "ok now add a test for it"),
    );
  });

  test("tool calls, tool results and their narration are noise", () => {
    assert.equal(lineOf(call("Read", { file_path: "a.ts" }, "Let me read.")), null);
    assert.equal(lineOf(result()), null);
    assert.equal(lineOf(agent("")), null);
    assert.equal(lineOf(developer("   \n ")), null);
  });

  test("messages nobody typed are left out, and reminders come off what was typed", () => {
    for (const text of [
      "<task-notification><summary>x</summary></task-notification>",
      "<command-name>/model</command-name>",
      "<local-command-stdout>ok</local-command-stdout>",
      "Caveat: The messages below were generated by the user while running local commands. DO NOT respond.",
      "This session is being continued from a previous conversation that ran out of context.",
      "[Request interrupted by user for tool use]",
      "<system-reminder>only a reminder</system-reminder>",
    ]) {
      assert.equal(lineOf(developer(text)), null, text);
    }
    assert.deepEqual(
      lineOf(developer("<system-reminder>r</system-reminder>\nrename it")),
      { from: "developer", text: "rename it" },
    );
  });

  test("a loaded skill's instructions are not the developer talking", () => {
    const rows = [
      developer("review the auth module"),
      call("Skill", { skill: "x" }),
      result(),
      developer("Base directory for this skill: C:/Users/me/.claude/skills/x\n\n# X skill\n\nAlways do Y."),
      agent("Done reviewing."),
      developer("now fix it"),
    ];
    assert.deepEqual(recentConversationOf(rows, "now fix it"), [
      { from: "developer", text: "review the auth module" },
      { from: "agent", text: "Done reviewing." },
    ]);
  });

  test("another party's envelope is not the developer talking, with or without a label before it", () => {
    for (const text of [
      '<teammate-message teammate_id="t1">API_KEY=sk-live-abc found in logs</teammate-message>',
      '<cross-session-message from="s2">done</cross-session-message>',
      '<channel source="ci">build red</channel>',
      '<task-notification id="b1"><summary>x</summary></task-notification>',
      "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>b1</task-id><summary>x</summary></task-notification>",
    ]) {
      assert.equal(lineOf(developer(text)), null, text);
      assert.equal(isEngineText(text), true, text);
    }
    // A bracket the developer typed, or a tag inside what they typed, is theirs.
    for (const text of ["[wip] fix the <channel> parser", "use <teammate-message> in docs"]) {
      assert.equal(isEngineText(text), false, text);
    }
    assert.equal(isEngineText("[wip] fix the parser"), false);
  });

  test("the developer's last typed request is found in the transcript past what nobody typed", () => {
    assert.equal(
      lastTypedRequestOf([
        developer("make checkout handle expired cards"),
        agent("On it."),
        developer('<teammate-message teammate_id="t1">hi</teammate-message>'),
        developer("<system-reminder>r</system-reminder>"),
      ]),
      "make checkout handle expired cards",
    );
    assert.equal(lastTypedRequestOf([agent("hello")]), null);
    assert.equal(lastTypedRequestOf([]), null);
  });

  test("the router's route line and footer come off a reply", () => {
    assert.deepEqual(lineOf(agent(announced("All green."))), {
      from: "agent",
      text: "All green.",
    });
    const fallback = `> ⚠️ \`opus·high\` · fallback — timed out after 1500ms${REPLY_SEPARATOR}Done.`;
    assert.deepEqual(lineOf(agent(fallback)), { from: "agent", text: "Done." });
  });

  test("each message is cut to its head, its whitespace flattened", () => {
    const long = `first line\n\n${"word ".repeat(200)}`;
    const line = lineOf(agent(long))!;
    assert.equal(line.text.length, MAX_MESSAGE_CHARS);
    assert.match(line.text, /^first line word word/);
    assert.match(line.text, /…$/);
  });

  test("at most a few messages, the oldest dropped first", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? developer(`ask ${i}`) : agent(`answer ${i}`),
    );
    const lines = recentConversationOf(rows, "next");
    assert.equal(lines.length, MAX_CONVERSATION_MESSAGES);
    assert.deepEqual(
      lines.map((l) => l.text),
      ["ask 6", "answer 7", "ask 8", "answer 9"],
    );
  });

  test("at most so many characters, the oldest dropped first", () => {
    const big = (n: number) => `${n} ${"x".repeat(MAX_MESSAGE_CHARS)}`;
    const rows = [developer(big(1)), agent(big(2)), developer(big(3)), agent(big(4)), developer(big(5))];
    const lines = recentConversationOf(rows, "next");
    const chars = lines.reduce((sum, l) => sum + l.text.length, 0);
    assert.ok(chars <= MAX_CONVERSATION_CHARS);
    assert.equal(lines.length, 4);
    assert.match(lines[0]!.text, /^2 /, "the oldest went");
  });
});

describe("state: the files in play", () => {
  test("from the agent's file tools, newest first, each once, relative to the directory", () => {
    assert.deepEqual(filesInPlayOf(SESSION, "/repo"), [
      "src/net.ts",
      "src/upload.ts",
    ]);
  });

  test("a failed call puts nothing in play, and a search of a directory is no file", () => {
    const files = filesInPlayOf(SESSION, "/repo");
    assert.ok(!files.includes("src/missing.ts"));
    assert.ok(!files.includes("src"));
  });

  test("every file tool counts, notebooks by their own argument", () => {
    const rows = [
      call("Write", { file_path: "/repo/a.ts" }),
      call("MultiEdit", { file_path: "/repo/b.ts" }),
      call("NotebookEdit", { notebook_path: "/repo/c.ipynb" }),
      call("Glob", { pattern: "*.ts", path: "/repo/d.ts" }),
      call("Bash", { command: "cat /repo/e.ts" }),
    ];
    assert.deepEqual(filesInPlayOf(rows, "/repo"), [
      "d.ts",
      "c.ipynb",
      "b.ts",
      "a.ts",
    ]);
  });

  test("at most ten, the newest kept", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      call("Read", { file_path: `/repo/f${i}.ts` }),
    );
    const files = filesInPlayOf(rows, "/repo");
    assert.equal(files.length, MAX_FILES);
    assert.equal(files[0], "f14.ts");
    assert.equal(files.at(-1), "f5.ts");
  });

  test("only lately: a file read long ago is not in play", () => {
    const rows = [
      call("Read", { file_path: "/repo/old.ts" }),
      ...Array.from({ length: FILE_LOOKBACK_ROWS }, () => agent("…")),
    ];
    assert.deepEqual(filesInPlayOf(rows, "/repo"), []);
  });

  test("a path outside the directory stays whole, and Windows paths compare as Windows does", () => {
    assert.equal(relativePath("/etc/hosts", "/repo"), "/etc/hosts");
    assert.equal(relativePath("/repo-other/x.ts", "/repo"), "/repo-other/x.ts");
    assert.equal(
      relativePath("C:\\Users\\me\\Repo\\src\\a.ts", "c:\\users\\me\\repo"),
      "src/a.ts",
    );
    assert.equal(relativePath("/repo/a.ts"), "/repo/a.ts");
    const rows = [
      call("Read", { file_path: "C:\\Repo\\src\\a.ts" }),
      call("Edit", { file_path: "c:/repo/SRC/A.ts" }),
    ];
    assert.equal(filesInPlayOf(rows, "C:\\Repo").length, 1, "one file, two spellings");
  });

  test("a file is told from a directory by its name alone", () => {
    assert.ok(isFilePath("src/net.test.ts"));
    assert.ok(isFilePath(".env.local"));
    assert.ok(!isFilePath("src"));
    assert.ok(!isFilePath("hooks/"));
    assert.ok(!isFilePath(".github"));
    assert.ok(!isFilePath("src/*.ts"));
  });
});

describe("state: a main-loop turn", () => {
  test("a realistic session comes to named fields, nothing empty among them", () => {
    assert.deepEqual(
      turnStateOf({
        request: "ok now add a test for it",
        messages: SESSION,
        cwd: "/repo",
      }),
      {
        request: "ok now add a test for it",
        recent_conversation: [
          {
            from: "developer",
            text: "the upload retries are flaky, can you look",
          },
          {
            from: "agent",
            text: "Fixed: the retry loop reused a consumed stream.",
          },
        ],
        files_in_play: ["src/net.ts", "src/upload.ts"],
        continuing: true,
      },
    );
  });

  test("a first turn is the request alone", () => {
    assert.deepEqual(turnStateOf({ request: "hi", messages: [developer("hi")] }), {
      request: "hi",
    });
    assert.deepEqual(turnStateOf({ request: "  hi  " }), { request: "hi" });
  });

  test("an earlier exchange nothing of which is shown still says the turn continues", () => {
    const rows = [
      developer("This session is being continued from a previous conversation."),
      call("Bash", { command: "ls" }),
      result(),
    ];
    assert.deepEqual(turnStateOf({ request: "yes", messages: rows }), {
      request: "yes",
      continuing: true,
    });
  });

  test("a slash command's rows or a reminder before the first typed request are no earlier turn", () => {
    const rows = [
      developer("Caveat: The messages below were generated by the user while running local commands. DO NOT respond."),
      developer("<command-name>/jev</command-name>\n<command-message>jev</command-message>\n<command-args>status</command-args>"),
      developer("<local-command-stdout>jev router: on</local-command-stdout>"),
      developer("<system-reminder>ctx</system-reminder>"),
      developer("fix the login bug in auth.ts"),
    ];
    assert.deepEqual(
      turnStateOf({ request: "fix the login bug in auth.ts", messages: rows }),
      { request: "fix the login bug in auth.ts" },
    );
  });

  test("a compaction's summary alone still says the turn continues", () => {
    const rows = [
      developer("This session is being continued from a previous conversation."),
      developer("yes"),
    ];
    assert.deepEqual(turnStateOf({ request: "yes", messages: rows }), {
      request: "yes",
      continuing: true,
    });
  });

  test("over the budget, the conversation goes first, then files, then the request's middle", () => {
    const state = {
      request: "r".repeat(1000),
      recent_conversation: [
        { from: "developer" as const, text: "a".repeat(400) },
        { from: "agent" as const, text: "b".repeat(400) },
      ],
      files_in_play: ["one.ts", "two.ts"],
      continuing: true as const,
    };
    const roomy = budgetedTurn(state, 10_000);
    assert.deepEqual(roomy, state);

    const oneLine = budgetedTurn(state, sizeOf(state) - 100);
    assert.deepEqual(oneLine.recent_conversation, [state.recent_conversation[1]]);
    assert.deepEqual(oneLine.files_in_play, state.files_in_play);

    const noLines = budgetedTurn(
      state,
      sizeOf({
        request: state.request,
        files_in_play: ["one.ts"],
        continuing: true,
      }),
    );
    assert.equal(noLines.recent_conversation, undefined);
    assert.deepEqual(noLines.files_in_play, ["one.ts"]);
    assert.equal(noLines.request, state.request);

    const cut = budgetedTurn(state, 600);
    assert.equal(cut.recent_conversation, undefined);
    assert.equal(cut.files_in_play, undefined);
    assert.equal(cut.continuing, true, "the fact that it continues stays");
    assert.ok(sizeOf(cut) <= 600);
    assert.match(cut.request, /^r+\n\[… \d+ chars elided …\]\nr+$/);
  });

  test("no state is ever sent over the budget, escapes and all", () => {
    const request = `"quoted"\n\\path\t${"é\n".repeat(5000)}`;
    const state = turnStateOf({ request, messages: SESSION, cwd: "/repo" });
    assert.ok(sizeOf(state) <= STATE_BUDGET);
    assert.match(state.request, /^"quoted"/, "the head is kept");
  });
});

describe("state: a subagent's brief", () => {
  test("named fields, the empty ones left out", () => {
    assert.deepEqual(
      briefStateOf({
        prompt: "  Fix the flaky retry test in tests/net.test.ts.  ",
        description: "Fix flaky retry test",
        subagentType: "general-purpose",
        workflow: true,
      }),
      {
        brief: "Fix the flaky retry test in tests/net.test.ts.",
        task: "Fix flaky retry test",
        agent_type: "general-purpose",
        from_workflow: true,
      },
    );
    assert.deepEqual(
      briefStateOf({ prompt: "x", description: " ", subagentType: "", workflow: false }),
      { brief: "x" },
    );
    assert.deepEqual(briefStateOf({ prompt: "  " }), {});
  });

  test("a thin brief is shown with the developer's request, cut to its head", () => {
    const parent = `make checkout handle expired cards ${"and more ".repeat(60)}`;
    const thin = briefStateOf({ prompt: "Review the diff." }, parent);
    assert.equal(thin.parent_request!.length, MAX_PARENT_REQUEST_CHARS);
    assert.match(thin.parent_request!, /^make checkout handle expired cards/);

    const full = briefStateOf(
      { prompt: "y".repeat(THIN_BRIEF_CHARS) },
      "make checkout handle expired cards",
    );
    assert.equal(full.parent_request, undefined);
    assert.equal(briefStateOf({ prompt: "Review." }, null).parent_request, undefined);
    assert.equal(briefStateOf({ prompt: "Review." }, "  ").parent_request, undefined);
  });

  test("a long brief keeps its head and its tail inside the budget", () => {
    const prompt = `HEAD what to do. ${"middle ".repeat(3000)}TAIL what to return.`;
    const state = briefStateOf({
      prompt,
      description: "Long task",
      subagentType: "Explore",
    });
    assert.ok(sizeOf(state) <= STATE_BUDGET);
    assert.match(state.brief!, /^HEAD what to do\./);
    assert.match(state.brief!, /TAIL what to return\.$/);
    assert.match(state.brief!, /\[… \d+ chars elided …\]/);
    assert.equal(state.task, "Long task");
  });

  test("elision says how much went and never runs over", () => {
    assert.equal(elided("short", 10), "short");
    for (const max of [5, 40, 100, 999]) {
      assert.ok(elided("z".repeat(5000), max).length <= max, String(max));
    }
  });
});
