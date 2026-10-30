/**
 * Asking Jev, TypeSafe's decision model, through either the Vercel AI
 * Gateway or TypeSafe's direct API.
 *
 * The gateway (POST /v1/evaluate) speaks its own vocabulary: question types
 * are `choice`, `score` and `boolean`, never TypeSafe's native `noul`, which
 * it rejects outright. Probabilities and confidences come back rounded to two
 * decimal places.
 *
 * TypeSafe direct (POST /v1/systemone) supports all three question types
 * (choice, score, noul) and returns probabilities rounded to four decimal
 * places.
 *
 * Both support the same `choice` and `score` question types and the same
 * `answers` response shape, so the request/response handling is identical.
 *
 * `fetch` and `sleep` are arguments rather than imports so this file runs
 * under plain `node` in tests, with no engine and no network.
 */

import {
  DEFAULT_LADDER,
  pairCriteriaOf,
  type FableMode,
  type Ladder,
  type Tier,
} from "./policy.ts";
import type { ProviderResult } from "./provider.ts";

/**
 * Measured against the live gateway on 2026-09-20: ten prompts ran 402ms to
 * 839ms. An 800ms budget failed open on the slowest of them, so this leaves
 * real headroom while still capping what a turn waits before giving up.
 * `JEV_ROUTER_TIMEOUT_MS` overrides it.
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/** A timeout from the environment, or the default when it is unusable. */
export function timeoutOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

export type HttpResponseLike = {
  ok: boolean;
  status: number;
  text: string;
};

/**
 * What one attempt at Jev came to. A failure carries its reason so the
 * session can say why a turn fell back to the default instead of going
 * quiet.
 */
export type JevResult =
  | { ok: true; answers: unknown; ms: number }
  | { ok: false; reason: string; ms: number };

export type AskArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  sleep: (ms: number) => Promise<unknown>;
  provider: ProviderResult;
  state: JevState;
  offered: readonly Tier[];
  /** Who wrote the state, which changes the question's wording. "turn" by default. */
  asking?: Asking;
  /**
   * The person's Fable setting, which decides what the criteria say and
   * whether Fable may be among them. "never" by default.
   */
  fable?: FableMode;
  /**
   * The ladder the router runs on, whose default family is the one the
   * criteria call the default. The default ladder when left out.
   */
  ladder?: Ladder;
  timeoutMs?: number;
  /** Injected so tests can measure without a real clock. */
  now?: () => number;
};

export type HttpInitLike = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * Who the state came from, which changes what Jev is told it is looking at.
 *
 * "turn" is a request a developer typed into the main session: short,
 * conversational, often leaning on context Jev cannot see. "subagent" is a
 * task a coding agent wrote out for a subagent (an Agent tool call or a
 * workflow script's `agent()`): longer, self-contained, and carried out
 * alone, with nobody to ask when it turns out harder than it looked.
 */
export type Asking = "turn" | "subagent";

/**
 * The `route` question's wording, per kind of state: one sentence saying
 * what is being chosen, a model and how hard it thinks, and who the work
 * is for. What each option means lives in `pairCriteriaOf`, so the two read
 * as one policy and neither repeats the other.
 *
 * Neither wording says where unclear work goes. The previous subagent
 * wording leaned toward the default, and with the default pair's own
 * sentence (`DEFAULT_PAIR_CLAUSE`) that was the same pull said twice; once,
 * on the option, is where it belongs. A subagent still differs from a turn
 * in what Jev is told it is: a task carried out alone, with nobody to ask
 * when it turns out harder than it looked.
 */
export const ASK_INSTRUCTIONS: Record<Asking, string> = {
  turn:
    "Which model, thinking how hard, should answer this request a " +
    "developer typed to a coding agent?",
  subagent:
    "Which model, thinking how hard, should carry out this task, which a " +
    "coding agent is handing to a subagent to do alone without asking " +
    "anyone for help?",
};

/**
 * What Jev is shown: the text a turn or a brief came to, or named fields
 * when a caller has more than one thing to show. TypeSafe reads a JSON
 * object as named parts a question can point at, which a string of
 * serialized JSON is not.
 */
export type JevState = string | Readonly<Record<string, unknown>>;

/** Whether a state has anything in it to judge. */
function hasContent(state: JevState): boolean {
  return typeof state === "string"
    ? state.trim() !== ""
    : Object.keys(state).length > 0;
}

/**
 * The request body for one routing decision: one Choice, `route`, among
 * the model·effort pairs the ladder allows for the offered families, each
 * described by `pairCriteriaOf`. `decisionOf` turns the answer into a
 * decision, family first.
 *
 * The criteria are the ones for the person's Fable setting, so a family
 * can mean something narrower when a higher one is on offer. Under "never"
 * Fable is dropped even if a caller offered it: `offeredTiers` already
 * leaves it out, and this keeps a stray offer from reaching Jev with a line
 * that says it is not offered. They are also the ones for the ladder: its
 * bands are which pairs there are, and its default pair is the one Jev is
 * told anything unclear belongs to.
 *
 * The model field is added by askJev depending on which provider is used.
 */
export function requestBodyOf(
  state: JevState,
  offered: readonly Tier[],
  asking: Asking = "turn",
  fable: FableMode = "never",
  ladder: Ladder = DEFAULT_LADDER,
) {
  return {
    state,
    questions: {
      route: {
        type: "choice" as const,
        instructions: ASK_INSTRUCTIONS[asking],
        criteria: pairCriteriaOf(offered, fable, ladder),
      },
    },
  };
}

/**
 * The most state a subagent's question sends. Briefs written by an agent
 * run long (whole files pasted in, a workflow's accumulated findings), and
 * every character is paid for and waited on before the subagent can start.
 * 8000 keeps a brief's shape, which is what difficulty is read from,
 * without shipping all of it.
 */
export const MAX_STATE_CHARS = 8000;

/** Caps on the header fields, so a runaway one cannot crowd out the brief. */
const MAX_TYPE_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 300;

function markerOf(count: number): string {
  return `[… ${count} chars elided …]`;
}

/**
 * `text` cut to at most `max` characters by dropping its middle.
 *
 * The head usually says what the task is and the tail usually says what to
 * hand back and when to stop, so both are kept, and the marker says how
 * much went missing between them rather than letting the cut pass for the
 * end of the brief.
 */
function elided(text: string, max: number): string {
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
 * The state for a subagent's question: what kind of agent it is, the short
 * summary its caller gave, whether a workflow script sent it, and then the
 * brief itself, its middle elided to fit `MAX_STATE_CHARS`.
 *
 * A header line is left out when there is nothing to say: an empty field
 * is still a field, and Jev can read an absence as a signal.
 */
export function subagentStateOf(spawn: {
  prompt: string;
  description?: string;
  subagentType?: string;
  workflow?: boolean;
}): string {
  const header: string[] = [];
  const type = spawn.subagentType?.trim();
  const description = spawn.description?.trim();
  if (type) header.push(`Subagent type: ${elided(type, MAX_TYPE_CHARS)}`);
  if (description)
    header.push(`Task: ${elided(description, MAX_DESCRIPTION_CHARS)}`);
  if (spawn.workflow) header.push("From a workflow script: yes");

  const prompt = spawn.prompt.trim();
  if (header.length === 0) return elided(prompt, MAX_STATE_CHARS);

  const top = header.join("\n");
  if (prompt === "") return top;
  return `${top}\n\n${elided(prompt, MAX_STATE_CHARS - top.length - 2)}`;
}

/**
 * Asks Jev and answers with the response's `answers` object, or a reason.
 *
 * Every failure sends the turn to the default, and it is a named one:
 * the caller reports the reason rather than leaving the person guessing
 * whether the router ran at all.
 */
export async function askJev(args: AskArgs): Promise<JevResult> {
  const {
    fetch,
    sleep,
    provider,
    state,
    offered,
    asking = "turn",
    fable = "never",
    ladder = DEFAULT_LADDER,
    now = () => Date.now(),
  } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();
  const since = () => now() - started;

  if (!provider.ok) return { ok: false, reason: provider.reason, ms: 0 };
  if (!hasContent(state)) return { ok: false, reason: "empty prompt", ms: 0 };
  if (offered.length === 0)
    return { ok: false, reason: "no tiers offered", ms: 0 };

  const TIMED_OUT = Symbol("timed-out");

  // Build the request body. For TypeSafe direct, we use the model name directly.
  // For the gateway, we still ask for it but the gateway ignores our model field
  // and uses typesafe-ai/jev regardless.
  const body = {
    ...requestBodyOf(state, offered, asking, fable, ladder),
    model: provider.model,
  };

  const call = fetch(provider.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let response: HttpResponseLike;
  try {
    const raced = await Promise.race([
      call,
      sleep(timeoutMs).then(() => TIMED_OUT),
    ]);
    if (raced === TIMED_OUT) {
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        ms: since(),
      };
    }
    response = raced as HttpResponseLike;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `request failed: ${detail}`, ms: since() };
  }

  if (!response) return { ok: false, reason: "no response", ms: since() };

  if (!response.ok) {
    return {
      ok: false,
      reason: `gateway said HTTP ${response.status}${gatewayNoteOf(response)}`,
      ms: since(),
    };
  }

  try {
    const parsed = JSON.parse(response.text) as { answers?: unknown };
    if (typeof parsed !== "object" || parsed === null || !parsed.answers) {
      return { ok: false, reason: "response carried no answers", ms: since() };
    }
    return { ok: true, answers: parsed.answers, ms: since() };
  } catch {
    return { ok: false, reason: "response was not JSON", ms: since() };
  }
}

/** The gateway's own error type, when it sent one, for the status line. */
function gatewayNoteOf(response: HttpResponseLike): string {
  try {
    const body = JSON.parse(response.text) as { error?: { type?: string } };
    const type = body?.error?.type;
    return typeof type === "string" ? ` (${type})` : "";
  } catch {
    return "";
  }
}
