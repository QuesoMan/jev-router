import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readFileSync } from "node:fs";

import { CONFIG_ENV_KEYS } from "../hooks/config.ts";
import {
  DEFAULT_PAIR_CLAUSE,
  EFFORTS,
  TIERS,
  type Effort,
} from "../hooks/policy.ts";
import { register } from "../hooks/register.ts";
import { concentrationOf, sharesFor, topOf } from "./jev-answers.ts";

/** A body as the router sends it to Jev, parsed. */
type Body = {
  state: unknown;
  questions: Record<
    string,
    {
      type: string;
      instructions: string;
      criteria: Record<string, string>;
    }
  >;
};

/** A body's state as named fields, which every state the router sends is. */
const stateOf = (body: Body) => body.state as Record<string, unknown>;

/** The families a body offers Jev, in ladder order: those of its pairs. */
const familiesIn = (body: {
  questions: Record<string, { criteria: Record<string, string> }>;
}) => [
  ...new Set(
    Object.keys(body.questions.route!.criteria).map((p) => p.split("_")[0]!),
  ),
];

/** Four decimals, as TypeSafe direct rounds them. */
const round4 = (p: number) => Math.round(p * 10000) / 10000;

/**
 * Jev's `route` answer to `body`, from a distribution over families and
 * an effort: each family's share goes on that family's pair at the effort
 * asked for, held to the efforts the body offers it (which is how Jev
 * answers: only with an option it was given). No effort sends each family
 * at the default pair's effort, the one the criteria call the catch-all,
 * held the same way. A family the body does not offer still gets its share
 * on the pair it would be, and a name that is not a family is sent as it
 * is, so a test can say what Jev answers with an option nobody offered.
 */
function routeAnswerOf(
  body: Body,
  shares: Readonly<Record<string, number>>,
  effort: number | undefined,
) {
  const criteria = body.questions.route?.criteria ?? {};
  const offered = Object.keys(criteria);
  const fallback =
    offered
      .find((p) => criteria[p]!.includes(DEFAULT_PAIR_CLAUSE))
      ?.split("_")[1] ?? "high";
  const wanted =
    typeof effort === "number" && Number.isFinite(effort)
      ? EFFORTS[Math.min(Math.max(Math.round(effort), 0), EFFORTS.length - 1)]!
      : fallback;
  const pairFor = (family: string): string => {
    if (!(TIERS as readonly string[]).includes(family)) return family;
    const own = offered
      .filter((p) => p.split("_")[0] === family)
      .map((p) => p.split("_")[1]!);
    if (own.length === 0) return `${family}_${wanted}`;
    const at = (e: string) => EFFORTS.indexOf(e as Effort);
    const lo = Math.min(...own.map(at));
    const hi = Math.max(...own.map(at));
    return `${family}_${EFFORTS[Math.min(Math.max(at(wanted), lo), hi)]}`;
  };
  const probabilities: Record<string, number> = {};
  for (const [name, p] of Object.entries(shares)) {
    const pair = pairFor(name);
    probabilities[pair] = round4((probabilities[pair] ?? 0) + p);
  }
  return {
    type: "choice",
    choice: topOf(probabilities),
    confidence: concentrationOf(probabilities, Math.max(offered.length, 2)),
    probabilities,
  };
}

describe("register: the env vars it reads", () => {
  test("every setting's env var is read, each by its literal name", () => {
    // The engine lists a module's env reads from literal `$.env.get` names,
    // so register.ts spells the four out; this keeps them in step.
    const source = readFileSync(
      new URL("../hooks/register.ts", import.meta.url),
      "utf8",
    );
    for (const name of CONFIG_ENV_KEYS) {
      assert.match(
        source,
        new RegExp(`\\$\\.env\\.get\\(\\s*"${name}"\\s*\\)`),
        name,
      );
    }
    assert.doesNotMatch(
      source,
      /\$\.env\.get\(\s*[^"\s]/,
      "no read by variable",
    );
  });
});

/**
 * Drives the real `register` with a fake engine: captures the hooks it
 * registers, then runs agent.spawn, turn.start and turn.step the way the
 * engine would.
 *
 * `held` stands for the host's `$.state`, which outlives the module: hand
 * one kit's `held` to a second `load` and the second is that module after
 * a reload.
 */
function load(
  env: Record<string, string> = { AI_GATEWAY_API_KEY: "gw-key" },
  options?: Record<string, string | number | boolean>,
  held = new Map<string, unknown>(),
) {
  let listCalls = 0;
  /** The session's agent list, which a test can add to. */
  const rows: {
    id: string;
    type: string;
    description: string;
    status: string;
    teammateId?: string;
  }[] = [
    {
      id: "agent-1",
      type: "general-purpose",
      description: "Review library-sync cluster",
      status: "running",
    },
  ];
  const keyOf = (ref: { plugin: string; key: string; id?: string }) =>
    `${ref.plugin}/${ref.key}/${ref.id ?? ""}`;
  const hooks = new Map<string, Function>();
  const on = (name: string, a: unknown, b?: unknown) => {
    const key = typeof a === "function" ? name : `${name}:${JSON.stringify(a)}`;
    hooks.set(key, (typeof a === "function" ? a : b) as Function);
    return { catch: () => {} };
  };
  register(on as never, options as never);

  let tier = "opus";
  let confidence = 0.91;
  /** A whole distribution, when a test set one, in place of `tier`'s. */
  let shares: Record<string, number> | undefined;
  /**
   * Jev's effort score, an index into `EFFORT_CRITERIA` (0 low to 4 max).
   * Undefined sends no effort answer at all, which a decision reads as the
   * default effort clamped into its family.
   */
  let effort: number | undefined;
  let ok = true;
  /** "hang": the next call never answers and its budget runs out. "throw": it throws. */
  let trouble: "hang" | "throw" | null = null;
  /** Every body sent to Jev, parsed, oldest first. */
  const asked: Body[] = [];
  /** What `$.session.messages({ agentId })` answers, by agent. */
  const transcripts = new Map<string, { role: string; text: string }[]>();
  /**
   * What `$.session.messages()` answers for the main loop, or what it
   * throws. Empty by default: a session with nothing before its turn.
   */
  let main: Record<string, unknown>[] | Error = [];
  /** How many times the main loop's transcript was read. */
  let mainReads = 0;
  /** What `$.session.cwd()` answers, or what it throws. */
  let cwd: string | Error = "/work/app";
  /** How many times the session's directory was read. */
  let cwdReads = 0;
  let hanging = false;

  const $ = {
    env: { get: async (k: string) => env[k] },
    clock: {
      sleep: () => (hanging ? Promise.resolve() : new Promise<never>(() => {})),
    },
    http: {
      fetch: (_url: string, init?: { body?: string }) => {
        const now = trouble;
        trouble = null;
        hanging = now === "hang";
        if (now === "throw") throw new Error("socket closed");
        const body = JSON.parse(init?.body ?? "{}") as Body;
        asked.push(body);
        if (now === "hang") return new Promise<never>(() => {});
        return answer(body);
      },
    },
    command: { register: async () => {} },
    session: {
      surface: async () => "test",
      messages: async (args?: { agentId?: string }) => {
        if (args?.agentId === undefined) {
          mainReads++;
          if (main instanceof Error) throw main;
          return structuredClone(main);
        }
        return (
          transcripts.get(args.agentId) ?? { deny: `no agent ${args.agentId}` }
        );
      },
      cwd: async () => {
        cwdReads++;
        if (cwd instanceof Error) throw cwd;
        return cwd;
      },
    },
    agent: {
      list: async () => {
        listCalls++;
        return [...rows];
      },
    },
    state: {
      get: async (ref: { plugin: string; key: string; id?: string }) => ({
        value: structuredClone(held.get(keyOf(ref))),
        version: held.has(keyOf(ref)) ? 1 : 0,
      }),
      set: async (
        ref: { plugin: string; key: string; id?: string },
        value: unknown,
      ) => {
        held.set(keyOf(ref), structuredClone(value));
        return { isSet: true, version: 1 };
      },
    },
  };
  /** Jev's answer as the fake provider sends it. */
  async function answer(body: Body) {
    const good = ok;
    ok = true;
    return {
      ok: good,
      status: good ? 200 : 500,
      headers: {},
      text: JSON.stringify({
        answers: {
          route: routeAnswerOf(
            body,
            shares ?? sharesFor(tier, confidence),
            effort,
          ),
        },
      }),
    };
  }
  return {
    hooks,
    $,
    asked,
    transcripts,
    rows,
    held,
    listCalls: () => listCalls,
    /** How many times the main loop's transcript was read. */
    mainReads: () => mainReads,
    /** How many times the session's directory was read. */
    cwdReads: () => cwdReads,
    /** The main loop's transcript from now on, or what reading it throws. */
    setMain: (rows: Record<string, unknown>[] | Error) => {
      main = rows;
    },
    /** The session's directory from now on, or what reading it throws. */
    setCwd: (dir: string | Error) => {
      cwd = dir;
    },
    /**
     * What Jev answers from the next call on: a family, the share of Jev's
     * probability on it (the rest where `sharesFor` puts Jev's doubt), and
     * an effort as a level or a raw score (none: no effort answer).
     */
    setTier: (name: string, c = 0.91, e?: Effort | number) => {
      tier = name;
      confidence = c;
      shares = undefined;
      effort = typeof e === "string" ? EFFORTS.indexOf(e) : e;
    },
    /** The same, from a whole distribution over the tiers. */
    setShares: (s: Record<string, number>, e?: Effort | number) => {
      shares = { ...s };
      effort = typeof e === "string" ? EFFORTS.indexOf(e) : e;
    },
    /** Makes only the next Jev call fail. */
    fail: () => {
      ok = false;
    },
    /** Makes only the next Jev call hang past its budget, or throw. */
    trouble: (kind: "hang" | "throw") => {
      trouble = kind;
    },
  };
}

/** Ends a turn the way the engine does, at its `turn.complete`. */
const complete = (
  hooks: Map<string, Function>,
  $: unknown,
  turnId: string,
  agentId?: string,
) =>
  hooks.get("turn.complete")!(
    $,
    {
      turnId,
      ...(agentId !== undefined ? { agentId } : {}),
      answer: "",
      durationMs: 1,
      isAborted: false,
      reason: "answer",
    },
    async () => ({ text: "" }),
  );

/** Starts a turn, main loop or a subagent's. */
const start = (
  hooks: Map<string, Function>,
  $: unknown,
  e: { text: string; turnId: string; agentId?: string },
) => hooks.get("turn.start")!($, e, async (x: unknown) => x);

async function* modelSays(...texts: string[]) {
  yield { kind: "engine", ref: 1 };
  for (const [i, text] of texts.entries())
    yield { kind: "text", index: 0, text, ref: i + 2 };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return { stopReason: "end_turn" };
}

const usage = (model: string, input_tokens = 1000) => ({
  model,
  input_tokens,
  output_tokens: 50,
  cache_read_input_tokens: 9000,
  cache_creation_input_tokens: 0,
});

async function* answeredBy(
  model: string,
  stopReason = "end_turn",
  input_tokens = 1000,
) {
  yield { kind: "text", index: 0, text: "reply", ref: 1 };
  yield { kind: "stop", stopReason, usage: usage(model, input_tokens), ref: 2 };
  return { stopReason };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const textOf = (chunks: { kind: string; text?: string }[]) =>
  chunks
    .filter((c) => c.kind === "text")
    .map((c) => c.text)
    .join("");

type Sent = { model?: string; effort?: string };

/** Runs one step through the hook, and says what the request was sent as. */
async function stepOf(
  hooks: Map<string, Function>,
  $: unknown,
  e: Record<string, unknown>,
  answer = () => answeredBy("claude-opus-5-5"),
) {
  let sent: Sent = {};
  const chunks = await collect(
    hooks.get("turn.step")!($, { index: 0, ...e }, (got: Sent) => {
      sent = got;
      return answer();
    }) as AsyncIterable<{ kind: string; text?: string }>,
  );
  return { sent, chunks, text: textOf(chunks) };
}

/** An `agent.spawn` input as the engine would raise it for the Agent tool. */
const spawnOf = (over: Record<string, unknown> = {}) => ({
  tool_use_id: "toolu_1",
  prompt: "Fix the flaky retry test in tests/net.test.ts.",
  description: "Fix flaky retry test",
  subagentType: "general-purpose",
  provider: { plugin: "engine", tier: "core" },
  parentModel: "claude-opus-5-5",
  background: false,
  fork: false,
  ...over,
});

/**
 * A fake `next` for agent.spawn: keeps what reached it and starts the agent
 * as `agentId`. `during` runs inside the call, before it answers, which is
 * where a real engine starts the agent's loop.
 */
function spawner(agentId: string, during?: () => Promise<void>) {
  const seen: Record<string, unknown>[] = [];
  const next = async (e: Record<string, unknown>) => {
    seen.push(e);
    if (during) await during();
    return { model: (e.model as string) ?? (e.parentModel as string), agentId };
  };
  return { next, seen };
}

const jev = (hooks: Map<string, Function>, $: unknown) =>
  hooks.get('command.run:{"command":"jev"}')!($, { args: "" }) as Promise<{
    text: string;
  }>;

describe("register: the route in the reply", () => {
  test("the first text chunk of a routed turn opens with the route line", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "implement it", turnId: "t1" },
      async (e: unknown) => e,
    );

    let sent: Sent = {};
    const step = hooks.get("turn.step")!(
      $,
      { turnId: "t1", index: 0, model: "claude-fable-5-1" },
      (e: Sent) => {
        sent = e;
        return modelSays("Hello", " there.");
      },
    );
    const chunks = await collect(step);
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);

    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "high");
    // The latency is wall-clock, so it is matched loosely.
    assert.match(texts[0]!, /^> ✳️ `opus·high` · 100% · \d+ms\n\n---\n\nHello$/);
    assert.equal(texts[1], " there.");
    assert.equal(
      chunks[0]!.kind,
      "engine",
      "engine chunks pass through untouched",
    );
  });

  test("the main loop asks Jev as a typed turn", async () => {
    const { hooks, $, asked } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "implement it", turnId: "t0" },
      async (e: unknown) => e,
    );
    assert.equal(asked.length, 1);
    // A first turn: nothing before it, so the request alone.
    assert.deepEqual(asked[0]!.state, { request: "implement it" });
    assert.deepEqual(Object.keys(asked[0]!.questions), ["route"]);
    assert.equal(asked[0]!.questions.route!.type, "choice");
    assert.match(asked[0]!.questions.route!.instructions, /developer typed/);
    assert.ok(
      Object.keys(asked[0]!.questions.route!.criteria).every((p) =>
        /^(haiku|sonnet|opus)_(low|medium|high|xhigh|max)$/.test(p),
      ),
      "every option is a family and effort pair",
    );
  });

  test("each family lands on its model, at Jev's effort clamped into its range", async () => {
    for (const [tier, score, model, effort] of [
      ["haiku", 0, "claude-haiku-5-5", "medium"],
      ["haiku", 4, "claude-haiku-5-5", "high"],
      ["sonnet", 1, "claude-sonnet-5-5", "medium"],
      ["sonnet", 4, "claude-sonnet-5-5", "max"],
      ["sonnet", undefined, "claude-sonnet-5-5", "high"],
      ["opus", 0, "claude-opus-5-5", "medium"],
      ["opus", 2, "claude-opus-5-5", "high"],
      ["opus", 3, "claude-opus-5-5", "xhigh"],
      ["opus", 4, "claude-opus-5-5", "max"],
    ] as const) {
      const { hooks, $, setTier } = load();
      setTier(tier, 0.9, score);
      await hooks.get("turn.start")!(
        $,
        { text: "x", turnId: "r" },
        async (e: unknown) => e,
      );
      const { sent } = await stepOf(hooks, $, { turnId: "r" });
      assert.deepEqual(
        { model: sent.model, effort: sent.effort },
        { model, effort },
        `${tier} at score ${score}`,
      );
    }
  });

  test("a haiku pick with effort score 0 runs haiku·medium, never low", async () => {
    const { hooks, $, setTier } = load();
    setTier("haiku", 0.95, 0);
    await start(hooks, $, { text: "what is 2+2", turnId: "h0" });
    const { sent, text } = await stepOf(hooks, $, {
      turnId: "h0",
      model: "claude-opus-5-5",
      effort: "low",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-haiku-5-5", effort: "medium" },
    );
    assert.match(text, /^> ✳️ `haiku·medium` · 95%/);
  });

  test("a sonnet pick with effort score 4 runs sonnet·max", async () => {
    const { hooks, $, setTier } = load();
    setTier("sonnet", 0.9, 4);
    await start(hooks, $, { text: "write the parser", turnId: "s4" });
    const { sent, text } = await stepOf(hooks, $, { turnId: "s4" });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "max" },
    );
    assert.match(text, /^> ✳️ `sonnet·max` · 90%/);
  });

  test("an old rung name in Jev's answer is not a tier, so the turn falls back to opus·high", async () => {
    const { hooks, $, setTier } = load();
    setTier("opus-max", 0.99, 4);
    await start(hooks, $, { text: "x", turnId: "old" });
    const { sent, text } = await stepOf(hooks, $, { turnId: "old" });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
    assert.match(text, /^> ⚠️ `opus·high` · fallback — Jev answered but named no pair/);
  });

  test("a pick the floor moves above Jev's top choice says so", async () => {
    const { hooks, $, setShares } = load();
    // Top choice Haiku, but only 40% says Haiku is enough; 75% says Sonnet
    // or cheaper is, so the floor (0.5) moves the pick up to Sonnet.
    setShares({ haiku: 0.4, sonnet: 0.35, opus: 0.25 });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "fl" },
      async (e: unknown) => e,
    );
    const { sent, text } = await stepOf(hooks, $, { turnId: "fl" });
    assert.equal(sent.model, "claude-sonnet-5-5");
    assert.match(text, /floored:haiku/);
  });

  test("the floor is read from the environment", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_MIN_CONFIDENCE: "0.2",
    });
    setTier("haiku", 0.3);
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "fe" },
      async (e: unknown) => e,
    );
    const { sent } = await stepOf(hooks, $, { turnId: "fe" });
    assert.equal(sent.model, "claude-haiku-5-5", "0.3 clears a 0.2 floor");
    assert.match(
      (await jev(hooks, $)).text,
      /floor\s+a pick needs 20% \(env\) of Jev's probability on its model or cheaper/,
    );
  });

  test("the line is put in once per turn, not once per step", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t2" },
      async (e: unknown) => e,
    );
    const run = (index: number) =>
      collect(
        hooks.get("turn.step")!($, { turnId: "t2", index }, () =>
          modelSays("reply"),
        ),
      );

    const first = await run(0);
    const second = await run(1);
    assert.match(
      first.find((c) => c.kind === "text")!.text,
      /^> ✳️ `opus·high`/,
    );
    assert.equal(second.find((c) => c.kind === "text")!.text, "reply");
  });

  test("with no key a Fable session model passes through untouched, and nothing is added", async () => {
    const { hooks, $, asked } = load({});
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t3" },
      async (e: unknown) => e,
    );
    const { sent, text } = await stepOf(
      hooks,
      $,
      { turnId: "t3", model: "claude-fable-5-1", effort: "xhigh" },
      () => modelSays("reply"),
    );
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-fable-5-1", effort: "xhigh" },
      "no key is routing off: no clamp either",
    );
    assert.equal(text, "reply", "no line, no footer");
    assert.equal(asked.length, 0);
    const report = (await jev(hooks, $)).text;
    assert.match(report, /routing\s+off — no Jev key is set/);
    assert.match(report, /set TYPESAFE_API_KEY \(or AI_GATEWAY_API_KEY\)/);
    assert.match(report, /No turns yet/);
  });

  test("no keys => fable and sonnet session models both pass through, subagent spawns untouched, no Jev call", async () => {
    const { hooks, $, asked } = load({});
    for (const [turnId, model] of [
      ["np-f", "claude-fable-5-1"],
      ["np-s", "claude-sonnet-5-5"],
    ] as const) {
      await start(hooks, $, { text: "x", turnId });
      const main = await stepOf(hooks, $, { turnId, model, effort: "medium" });
      assert.deepEqual(
        { model: main.sent.model, effort: main.sent.effort },
        { model, effort: "medium" },
        model,
      );
    }

    for (const model of ["claude-fable-5-1", "claude-sonnet-5-5"]) {
      const { next, seen } = spawner(`np-${model}`);
      const e = spawnOf({ model });
      await hooks.get("agent.spawn")!($, e, next);
      assert.equal(seen[0], e, "passed on as it came");
      await start(hooks, $, {
        text: e.prompt,
        turnId: `np-${model}-t`,
        agentId: `np-${model}`,
      });
      const sub = await stepOf(hooks, $, {
        turnId: `np-${model}-t`,
        agentId: `np-${model}`,
        model,
        effort: "xhigh",
      });
      assert.deepEqual(
        { model: sub.sent.model, effort: sub.sent.effort },
        { model, effort: "xhigh" },
      );
    }

    // A loop the session lists, with no spawn: not asked about either.
    await start(hooks, $, {
      text: "Summarize the changelog.",
      turnId: "np-skill",
      agentId: "agent-1",
    });
    const fork = spawnOf({
      fork: true,
      subagentType: "fork",
      model: "claude-fable-5-1",
    });
    const forked = spawner("np-fork");
    await hooks.get("agent.spawn")!($, fork, forked.next);
    assert.equal(forked.seen[0], fork);

    assert.equal(asked.length, 0, "Jev never asked");
  });

  test("a key set mid-session turns routing on at the next turn", async () => {
    const env: Record<string, string> = {};
    const { hooks, $, asked } = load(env);
    await start(hooks, $, { text: "x", turnId: "k0" });
    assert.equal(asked.length, 0);
    env.AI_GATEWAY_API_KEY = "gw-key";
    await start(hooks, $, { text: "x", turnId: "k1" });
    assert.equal(asked.length, 1);
    const { sent } = await stepOf(hooks, $, {
      turnId: "k1",
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-opus-5-5");
  });

  test("a call that runs out of budget falls back to the default", async () => {
    const { hooks, $, trouble, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_TIMEOUT_MS: "300",
    });
    setTier("haiku", 0.99);
    trouble("hang");
    await start(hooks, $, { text: "x", turnId: "to" });
    const { sent, text } = await stepOf(hooks, $, {
      turnId: "to",
      model: "claude-sonnet-5-5",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "high");
    assert.match(text, /fallback — timed out after 300ms/);
  });

  test("a Jev call that throws falls through to the default, and the spawn still goes", async () => {
    const { hooks, $, trouble } = load();
    trouble("throw");
    const { next, seen } = spawner("thrown");
    const out = await hooks.get("agent.spawn")!($, spawnOf(), next);
    assert.equal(out.agentId, "thrown", "never denied");
    assert.equal(seen[0]!.model, "claude-opus-5-5");
    assert.match((await jev(hooks, $)).text, /fallback — router error/);
  });

  test("a failed Jev call falls back to the default too", async () => {
    const { hooks, $, fail, setTier } = load();
    setTier("haiku", 0.99);
    fail();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "tf" },
      async (e: unknown) => e,
    );
    const { sent, text } = await stepOf(hooks, $, { turnId: "tf" });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "high");
    assert.match(text, /fallback — gateway said HTTP 500/);
  });

  test("a step whose first chunks are not text waits for the text", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t4" },
      async (e: unknown) => e,
    );
    async function* thinkingFirst() {
      yield { kind: "thinking", index: 0, text: "hmm" };
      yield { kind: "text", index: 1, text: "answer" };
      yield { kind: "stop", stopReason: "end_turn", usage: null };
    }
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t4", index: 0 }, () =>
        thinkingFirst(),
      ),
    );
    assert.equal(chunks[0]!.text, "hmm", "thinking is not where the line goes");
    assert.match(chunks[1]!.text, /^> ✳️ `opus·high`.*\n\n---\n\nanswer$/);
  });

  test("/jev quiet keeps routing but drops the line", async () => {
    const { hooks, $ } = load();
    const cmd = hooks.get('command.run:{"command":"jev"}')!;
    await cmd($, { args: "quiet" });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t5" },
      async (e: unknown) => e,
    );
    const { sent, chunks } = await stepOf(hooks, $, { turnId: "t5" }, () =>
      modelSays("reply"),
    );
    assert.equal(sent.model, "claude-opus-5-5", "still routed");
    assert.equal(chunks.find((c) => c.kind === "text")!.text, "reply");
  });

  test("the stop chunk’s usage lands on the turn and /jev confirms what answered", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t6" },
      async (e: unknown) => e,
    );
    const { chunks } = await stepOf(hooks, $, { turnId: "t6" });
    assert.equal(
      chunks.at(-1)!.kind,
      "stop",
      "the stop chunk still reaches the engine",
    );

    const out = await jev(hooks, $);
    assert.match(out.text, /claude-opus-5-5 ✓/);
    assert.match(out.text, /cache 90%/);
  });

  test("a turn of two steps sums both requests", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t7" },
      async (e: unknown) => e,
    );
    await stepOf(hooks, $, { turnId: "t7" }, () =>
      answeredBy("claude-opus-5-5", "tool_use", 1000),
    );
    await stepOf(hooks, $, { turnId: "t7", index: 1 }, () =>
      answeredBy("claude-opus-5-5", "end_turn", 3000),
    );
    const out = await jev(hooks, $);
    assert.match(out.text, /22k in/, out.text);
  });

  test("a different model answering than was asked for is flagged", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t8" },
      async (e: unknown) => e,
    );
    await stepOf(hooks, $, { turnId: "t8" }, () =>
      answeredBy("claude-haiku-4-5"),
    );
    assert.match(
      (await jev(hooks, $)).text,
      /claude-haiku-4-5 ≠ claude-opus-5-5/,
    );
  });

  test("a stop chunk for a turn we never saw is left alone", async () => {
    const { hooks, $ } = load();
    const { chunks, sent } = await stepOf(hooks, $, {
      turnId: "ghost",
      model: "claude-sonnet-5-5",
    });
    assert.equal(chunks.length, 2);
    assert.equal(sent.model, "claude-sonnet-5-5", "not forbidden, not touched");
  });

  test("the footer closes a finished turn, after the reply text", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t9" },
      async (e: unknown) => e,
    );
    const { chunks } = await stepOf(hooks, $, { turnId: "t9" });

    const texts = chunks.filter((c) => c.kind === "text") as {
      text: string;
      index: number;
      ref?: number;
    }[];
    const footer = texts.at(-1)!.text;
    assert.match(footer, /```\n─+\njev {2}opus·high/);
    assert.match(footer, /api {2}claude-opus-5-5 ✓/);
    assert.equal(
      chunks.at(-1)!.kind,
      "stop",
      "the footer goes before the stop chunk",
    );
    assert.equal(
      texts.at(-1)!.ref,
      undefined,
      "a chunk we made carries no engine handle",
    );

    // Load-bearing: the engine drops a chunk yielded at an index it already
    // streamed. One past the last text block opens a block of its own.
    const reply = texts.find((c) => c.ref !== undefined)!;
    assert.equal(texts.at(-1)!.index, reply.index + 1);
  });

  test("a step that only called a tool gets no footer, since the turn goes on", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t10" },
      async (e: unknown) => e,
    );
    const mid = await stepOf(hooks, $, { turnId: "t10" }, () =>
      answeredBy("claude-opus-5-5", "tool_use"),
    );
    assert.doesNotMatch(mid.text, /jev {2}opus/);

    const last = await stepOf(hooks, $, { turnId: "t10", index: 1 });
    assert.match(
      last.chunks.filter((c) => c.kind === "text").at(-1)!.text!,
      /jev {2}opus·high/,
    );
  });

  test("the footer sums the whole turn, not just its last step", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t11" },
      async (e: unknown) => e,
    );
    await stepOf(hooks, $, { turnId: "t11" }, () =>
      answeredBy("claude-opus-5-5", "tool_use", 1000),
    );
    const last = await stepOf(hooks, $, { turnId: "t11", index: 1 }, () =>
      answeredBy("claude-opus-5-5", "end_turn", 3000),
    );
    assert.match(
      last.chunks.filter((c) => c.kind === "text").at(-1)!.text!,
      /22k in/,
    );
  });

  test("/jev quiet drops the footer with the line", async () => {
    const { hooks, $ } = load();
    await hooks.get('command.run:{"command":"jev"}')!($, { args: "quiet" });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t12" },
      async (e: unknown) => e,
    );
    const { text } = await stepOf(hooks, $, { turnId: "t12" });
    assert.equal(text, "reply");
  });

  test("a turn whose response carried no usage ends without a footer", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t13" },
      async (e: unknown) => e,
    );
    const { text } = await stepOf(hooks, $, { turnId: "t13" }, () =>
      modelSays("reply"),
    );
    assert.doesNotMatch(text, /jev {2}opus/);
  });

  test("a turn started by a task notification is tagged notify, in the line and the footer", async () => {
    const { hooks, $ } = load();
    const notice =
      '<task-notification><task-id>abc</task-id><summary>Agent "reviewer" completed</summary></task-notification>';
    await hooks.get("turn.start")!(
      $,
      { text: notice, turnId: "n1" },
      async (e: unknown) => e,
    );
    const { chunks } = await stepOf(hooks, $, { turnId: "n1" });
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text!);
    assert.match(texts[0]!, /^> ✳️ `opus·high` · 100% · notify · \d+ms/);
    assert.match(texts.at(-1)!, /jev {2}opus·high · 100% · notify · \d+ms/);
    assert.match(
      (await jev(hooks, $)).text,
      /\[notify\] Agent "reviewer" completed/,
    );
  });

  test("a main-loop step on a Fable session model with no decision is moved to the default", async () => {
    const { hooks, $ } = load();
    const { sent } = await stepOf(hooks, $, {
      turnId: "never-started",
      model: "claude-fable-5-1",
      effort: "xhigh",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "high");
  });

  test("an alias or a dated Fable id is caught as well", async () => {
    const { hooks, $ } = load();
    for (const model of ["fable", "claude-fable-5-1-20260901"]) {
      const { sent } = await stepOf(hooks, $, { turnId: model, model });
      assert.equal(sent.model, "claude-opus-5-5", model);
    }
  });

  test("a main-loop step never touches the agent list", async () => {
    const { hooks, $, listCalls } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "s4" },
      async (e: unknown) => e,
    );
    await stepOf(hooks, $, { turnId: "s4" });
    assert.equal(listCalls(), 0);
  });
});

describe("register: subagents", () => {
  const spawn = (
    hooks: Map<string, Function>,
    $: unknown,
    e: Record<string, unknown>,
    next: (e: Record<string, unknown>) => Promise<unknown>,
  ) =>
    hooks.get("agent.spawn")!($, e, next) as Promise<{
      model?: string;
      agentId?: string;
    }>;

  test("an Agent-tool subagent is routed by its task, overriding the model its caller asked for", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("sonnet", 0.8);
    const { next, seen } = spawner("agent-7");
    const out = await spawn(hooks, $, spawnOf({ model: "haiku" }), next);

    assert.equal(seen[0]!.model, "claude-sonnet-5-5");
    assert.equal(seen[0]!.prompt, spawnOf().prompt, "the prompt is untouched");
    assert.equal(out.agentId, "agent-7");

    assert.equal(asked.length, 1);
    // A full brief: no developer request beside it, and none was typed.
    assert.deepEqual(asked[0]!.state, {
      brief: spawnOf().prompt,
      task: "Fix flaky retry test",
      agent_type: "general-purpose",
    });
    assert.match(asked[0]!.questions.route!.instructions, /subagent/);

    const report = (await jev(hooks, $)).text;
    assert.match(
      report,
      /sonnet·high 0\.80 {2}\[agent:general-purpose\] Fix flaky retry test/,
    );
    assert.match(report, /asked haiku → sonnet·high/);
  });

  test("its steps run at the decision's effort, found by the agent's id", async () => {
    const { hooks, $, setTier } = load();
    setTier("sonnet", 0.8, "medium");
    const { next } = spawner("agent-7");
    await spawn(hooks, $, spawnOf(), next);

    const { sent } = await stepOf(hooks, $, {
      turnId: "sub-t1",
      agentId: "agent-7",
      model: "claude-opus-5-5",
      effort: "high",
    });
    assert.equal(sent.model, "claude-sonnet-5-5");
    assert.equal(sent.effort, "medium");
  });

  test("a subagent spawn's effort lands on every one of its steps", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("opus", 0.9, 3);
    const { next } = spawner("agent-x");
    await spawn(hooks, $, spawnOf(), next);
    await start(hooks, $, {
      text: spawnOf().prompt,
      turnId: "x-t",
      agentId: "agent-x",
    });
    for (const index of [0, 1, 2]) {
      const { sent } = await stepOf(hooks, $, {
        turnId: "x-t",
        agentId: "agent-x",
        index,
        model: "claude-opus-5-5",
        effort: "high",
      });
      assert.deepEqual(
        { model: sent.model, effort: sent.effort },
        { model: "claude-opus-5-5", effort: "xhigh" },
        `step ${index}`,
      );
    }
    assert.equal(asked.length, 1, "asked once, at the spawn");
  });

  test("its turn.start is tied to the spawn's answer without asking Jev again", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("opus", 0.9, "max");
    const { next } = spawner("agent-7");
    await spawn(hooks, $, spawnOf(), next);
    await hooks.get("turn.start")!(
      $,
      { text: spawnOf().prompt, turnId: "sub-t2", agentId: "agent-7" },
      async (e: unknown) => e,
    );
    assert.equal(asked.length, 1, "only the spawn asked");

    const { sent } = await stepOf(hooks, $, {
      turnId: "sub-t2",
      agentId: "agent-7",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "max");
  });

  test("a workflow agent is routed, and a script's Fable is overridden", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("opus", 0.9, "max");
    const { next, seen } = spawner("wf-agent-3");
    await spawn(
      hooks,
      $,
      spawnOf({
        model: "claude-fable-5-1",
        workflow: { runId: "wf_123", agentIndex: 3 },
        tool_use_id: "",
      }),
      next,
    );
    assert.equal(seen[0]!.model, "claude-opus-5-5");
    assert.equal(stateOf(asked[0]!).from_workflow, true);

    const { sent } = await stepOf(hooks, $, {
      turnId: "wf-t",
      agentId: "wf-agent-3",
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "max");

    const report = (await jev(hooks, $)).text;
    assert.match(report, /\[workflow:general-purpose\]/);
    assert.match(report, /asked claude-fable-5-1 → opus·max/);
  });

  test("Jev failing on a subagent sends it to the default, never the caller's model", async () => {
    const { hooks, $, fail } = load();
    fail();
    const { next, seen } = spawner("agent-8");
    await spawn(hooks, $, spawnOf({ model: "claude-sonnet-5-5" }), next);
    assert.equal(seen[0]!.model, "claude-opus-5-5");

    const { sent } = await stepOf(hooks, $, {
      turnId: "f-t",
      agentId: "agent-8",
    });
    assert.equal(sent.effort, "high");
    assert.match(
      (await jev(hooks, $)).text,
      /opus·high fallback — gateway said HTTP 500.* {2}\[agent:general-purpose\]/,
    );
  });

  test("with no key a subagent asking for Fable is passed on as it came, its steps too", async () => {
    const { hooks, $ } = load({});
    const { next, seen } = spawner("agent-8");
    const e = spawnOf({ model: "claude-fable-5-1" });
    await spawn(hooks, $, e, next);
    assert.equal(seen[0], e);
    const { sent } = await stepOf(hooks, $, {
      turnId: "nk-t",
      agentId: "agent-8",
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-fable-5-1");
    const report = (await jev(hooks, $)).text;
    assert.match(
      report,
      /unrouted — \[agent\] agent-8/,
      "the row is the old off-mode bookkeeping, nothing more",
    );
    assert.doesNotMatch(report, /blocked claude-fable/);
  });

  test("a fork is not asked about, but a Fable model on it is still moved", async () => {
    const { hooks, $, asked } = load();
    const { next, seen } = spawner("fork-1");
    await spawn(
      hooks,
      $,
      spawnOf({ fork: true, subagentType: "fork", model: "claude-fable-5-1" }),
      next,
    );
    assert.equal(asked.length, 0, "a fork keeps its parent's cache");
    assert.equal(seen[0]!.model, "claude-opus-5-5");

    // A fork inherits the parent's model whatever the spawn says, so the
    // guard that counts is at its steps.
    const { sent } = await stepOf(hooks, $, {
      turnId: "fork-t",
      agentId: "fork-1",
      model: "claude-fable-5-1",
      effort: "xhigh",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "high");

    const report = (await jev(hooks, $)).text;
    assert.match(report, /unrouted — \[agent\] fork-1/);
    assert.match(report, /blocked claude-fable-5-1 → opus·high/);
  });

  test("a fork on an allowed model is passed on as it came, and its steps left alone", async () => {
    const { hooks, $ } = load();
    const { next, seen } = spawner("fork-2");
    const e = spawnOf({ fork: true, subagentType: "fork" });
    await spawn(hooks, $, e, next);
    assert.equal(seen[0], e);

    const { sent } = await stepOf(hooks, $, {
      turnId: "fork-t2",
      agentId: "fork-2",
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "medium" },
    );
  });

  test("a resume is not asked about again, and keeps the decision its spawn made", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("sonnet", 0.8);
    await spawn(hooks, $, spawnOf(), spawner("agent-9").next);
    assert.equal(asked.length, 1);

    setTier("opus", 0.9, "max");
    const { next, seen } = spawner("agent-9");
    const resume = spawnOf({
      prompt: "Keep going.",
      resume: { agentId: "agent-9" },
    });
    await spawn(hooks, $, resume, next);
    assert.equal(asked.length, 1, "not re-asked");
    assert.equal(seen[0], resume, "passed on untouched");

    await hooks.get("turn.start")!(
      $,
      { text: "Keep going.", turnId: "res-t", agentId: "agent-9" },
      async (e: unknown) => e,
    );
    const { sent } = await stepOf(hooks, $, {
      turnId: "res-t",
      agentId: "agent-9",
    });
    assert.equal(sent.model, "claude-sonnet-5-5");
    assert.equal(sent.effort, "high");
  });

  test("an agent whose loop starts before the spawn answers is found by its prompt", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("haiku", 0.95, 0);
    const e = spawnOf({ prompt: "Say which file defines the retry limit." });
    let early: Sent = {};
    const { next } = spawner("agent-race", async () => {
      await hooks.get("turn.start")!(
        $,
        { text: e.prompt, turnId: "race-t", agentId: "agent-race" },
        async (x: unknown) => x,
      );
      early = (
        await stepOf(hooks, $, { turnId: "race-t", agentId: "agent-race" })
      ).sent;
    });
    await spawn(hooks, $, e, next);

    assert.equal(asked.length, 1);
    assert.equal(early.model, "claude-haiku-5-5");
    assert.equal(early.effort, "medium");
  });

  test("with no turn.start at all, an early step is found by the prompt its loop began with", async () => {
    const { hooks, $, setTier, transcripts } = load();
    setTier("sonnet", 0.8, "medium");
    const e = spawnOf({ prompt: "Rename foo to bar in util.ts." });
    transcripts.set("agent-early", [{ role: "user", text: e.prompt }]);
    let early: Sent = {};
    const { next } = spawner("agent-early", async () => {
      early = (
        await stepOf(hooks, $, { turnId: "early-t", agentId: "agent-early" })
      ).sent;
    });
    await spawn(hooks, $, e, next);

    assert.equal(early.model, "claude-sonnet-5-5");
    assert.equal(early.effort, "medium");
    const report = (await jev(hooks, $)).text;
    assert.equal(report.match(/\[agent:general-purpose\]/g)?.length, 1);
  });

  test("nothing is put into a subagent's reply, routed or not", async () => {
    const { hooks, $ } = load();
    await spawn(hooks, $, spawnOf(), spawner("agent-7").next);
    await hooks.get("turn.start")!(
      $,
      { text: spawnOf().prompt, turnId: "q-t", agentId: "agent-7" },
      async (e: unknown) => e,
    );
    const routed = await stepOf(hooks, $, {
      turnId: "q-t",
      agentId: "agent-7",
    });
    assert.equal(routed.text, "reply", "no line, no footer");

    const unrouted = await stepOf(hooks, $, {
      turnId: "q-u",
      agentId: "agent-1",
    });
    assert.equal(unrouted.text, "reply");
  });

  test("a subagent's usage lands on its spawn's row", async () => {
    const { hooks, $, setTier } = load();
    setTier("sonnet", 0.8);
    await spawn(hooks, $, spawnOf(), spawner("agent-7").next);
    await stepOf(hooks, $, { turnId: "u-t", agentId: "agent-7" }, () =>
      answeredBy("claude-sonnet-5-5", "tool_use", 1000),
    );
    await stepOf(
      hooks,
      $,
      { turnId: "u-t", agentId: "agent-7", index: 1 },
      () => answeredBy("claude-sonnet-5-5", "end_turn", 3000),
    );
    const report = (await jev(hooks, $)).text;
    assert.match(report, /answered claude-sonnet-5-5 ✓ .* 22k in/);
    assert.equal(report.match(/\[agent:/g)?.length, 1);
  });

  test("a subagent’s step with no spawn seen is recorded unrouted with what ran it", async () => {
    const { hooks, $, listCalls } = load();
    const { sent, text } = await stepOf(hooks, $, {
      turnId: "sub1",
      agentId: "agent-1",
      model: "claude-opus-5-5",
    });
    assert.equal(sent.model, "claude-opus-5-5", "left on its model");
    assert.equal(text, "reply", "nothing added to a tool result");
    const out = (await jev(hooks, $)).text;
    assert.match(
      out,
      /unrouted — \[agent:general-purpose\] Review library-sync cluster/,
    );
    assert.match(out, /answered claude-opus-5-5/);
    assert.equal(listCalls(), 1);
  });

  test("an unrouted subagent’s later steps add to the same record, and read the list once", async () => {
    const { hooks, $, listCalls } = load();
    await stepOf(hooks, $, { turnId: "sub2", agentId: "agent-1" }, () =>
      answeredBy("claude-opus-5-5", "tool_use", 1000),
    );
    await stepOf(
      hooks,
      $,
      { turnId: "sub2", agentId: "agent-1", index: 1 },
      () => answeredBy("claude-opus-5-5", "end_turn", 3000),
    );
    const out = (await jev(hooks, $)).text;
    assert.equal(out.match(/unrouted — \[agent/g)?.length, 1);
    assert.match(out, /22k in/);
    assert.equal(listCalls(), 1);
  });

  test("an agent the list does not know yet is still recorded, by its id", async () => {
    const { hooks, $ } = load();
    await stepOf(hooks, $, { turnId: "sub3", agentId: "agent-unknown-xyz" });
    assert.match(
      (await jev(hooks, $)).text,
      /unrouted — \[agent\] agent-unknown-xyz/,
    );
  });
});

describe("register: routing off", () => {
  test("/jev off leaves every spawn, turn and step exactly as it came", async () => {
    const { hooks, $, asked } = load();
    await hooks.get('command.run:{"command":"jev"}')!($, { args: "off" });

    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "off-t" },
      async (e: unknown) => e,
    );
    const main = await stepOf(hooks, $, {
      turnId: "off-t",
      model: "claude-sonnet-5-5",
      effort: "xhigh",
    });
    assert.deepEqual(
      { model: main.sent.model, effort: main.sent.effort },
      { model: "claude-sonnet-5-5", effort: "xhigh" },
    );
    assert.equal(main.text, "reply", "no line, no footer");

    const e = spawnOf({ model: "claude-sonnet-5-5" });
    const { next, seen } = spawner("agent-off");
    await hooks.get("agent.spawn")!($, e, next);
    assert.equal(seen[0], e);

    const sub = await stepOf(hooks, $, {
      turnId: "off-s",
      agentId: "agent-off",
      model: "claude-sonnet-5-5",
    });
    assert.equal(sub.sent.model, "claude-sonnet-5-5");
    assert.equal(asked.length, 0, "Jev never asked");
  });

  test("with /jev off a fable session model passes through untouched, everywhere", async () => {
    const { hooks, $, asked } = load();
    const off = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "off",
    });
    assert.match(off.text, /Fable included/);

    await start(hooks, $, { text: "x", turnId: "offf" });
    const main = await stepOf(hooks, $, {
      turnId: "offf",
      model: "claude-fable-5-1",
      effort: "xhigh",
    });
    assert.deepEqual(
      { model: main.sent.model, effort: main.sent.effort },
      { model: "claude-fable-5-1", effort: "xhigh" },
    );

    const e = spawnOf({ model: "claude-fable-5-1" });
    const { next, seen } = spawner("agent-offf");
    await hooks.get("agent.spawn")!($, e, next);
    assert.equal(seen[0], e, "not even the model is touched");

    const fork = spawnOf({
      fork: true,
      subagentType: "fork",
      model: "claude-fable-5-1",
    });
    const forked = spawner("fork-offf");
    await hooks.get("agent.spawn")!($, fork, forked.next);
    assert.equal(forked.seen[0], fork);

    const sub = await stepOf(hooks, $, {
      turnId: "offf-s",
      agentId: "agent-offf",
      model: "claude-fable-5-1",
    });
    assert.equal(sub.sent.model, "claude-fable-5-1");
    assert.equal(asked.length, 0, "Jev never asked");
    assert.match((await jev(hooks, $)).text, /blocked\s+nothing, routing is off/);
  });

  test("/jev on with no key says nothing is routed yet", async () => {
    const { hooks, $ } = load({});
    const on = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "on",
    });
    assert.match(on.text, /nothing is routed yet/);
  });

  test("a subagent routed before /jev off is not rewritten after it", async () => {
    const { hooks, $, setTier } = load();
    setTier("haiku", 0.95, 0);
    await hooks.get("agent.spawn")!($, spawnOf(), spawner("agent-x").next);
    await hooks.get('command.run:{"command":"jev"}')!($, { args: "off" });
    const { sent } = await stepOf(hooks, $, {
      turnId: "x-t",
      agentId: "agent-x",
      model: "claude-opus-5-5",
    });
    assert.equal(sent.model, "claude-opus-5-5");
  });
});

describe("register: stickiness", () => {
  /**
   * A session whose env asks for stickiness, started: the env is read in
   * session.start, which the engine always fires and a test must too.
   */
  const sticky = async (over: Record<string, string> = {}) => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      ...over,
    });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  /** Runs one turn end to end and says which model the request named. */
  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    return stepOf(hooks, $, { turnId: id });
  }

  // 0.6 clears the confidence floor (0.5) but not the sticky bar (0.75):
  // the switch down that stickiness is for.
  test("with the flag off, a shaky switch still moves the model", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "a1");
    setTier("sonnet", 0.6);
    const second = await turn(hooks, $, "a2");
    assert.equal(second.sent.model, "claude-sonnet-5-5");
    assert.doesNotMatch(second.text, /held/);
  });

  test("with the flag on, a shaky switch is held on the last model", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "b1");
    setTier("sonnet", 0.6);
    const second = await turn(hooks, $, "b2");
    assert.equal(
      second.sent.model,
      "claude-opus-5-5",
      "held on the first turn’s model",
    );
    assert.match(second.text, /held:sonnet/);
  });

  test("a confident switch still goes through with the flag on", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "c1");
    setTier("sonnet", 0.9);
    const second = await turn(hooks, $, "c2");
    assert.equal(second.sent.model, "claude-sonnet-5-5");
  });

  test("a move up is never held, however shaky", async () => {
    const { hooks, $, setTier, setShares } = await sticky();
    setTier("sonnet", 0.9);
    await turn(hooks, $, "u1");
    // 40% says Sonnet will do, so the median is Opus: a shaky move up.
    setShares({ sonnet: 0.4, opus: 0.6 }, "max");
    const second = await turn(hooks, $, "u2");
    assert.equal(second.sent.model, "claude-opus-5-5");
    assert.equal(second.sent.effort, "max");
  });

  test("the bar is read from the environment", async () => {
    const { hooks, $, setTier } = await sticky({
      JEV_ROUTER_STICKY_CONFIDENCE: "0.55",
    });
    await turn(hooks, $, "d1");
    setTier("sonnet", 0.6);
    assert.equal(
      (await turn(hooks, $, "d2")).sent.model,
      "claude-sonnet-5-5",
      "0.6 clears a 0.55 bar",
    );
  });

  test("effort moves on a held turn, since it keeps the same model", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "e1");
    setTier("sonnet", 0.6, "medium");
    const second = await turn(hooks, $, "e2");
    assert.equal(second.sent.model, "claude-opus-5-5");
    assert.equal(second.sent.effort, "medium");
  });

  test("a held turn becomes the model the next turn holds to", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "f1");
    setTier("sonnet", 0.6);
    await turn(hooks, $, "f2");
    const third = await turn(hooks, $, "f3");
    assert.equal(
      third.sent.model,
      "claude-opus-5-5",
      "still the model that is actually running",
    );
  });

  test("a fallback turn is what the next turn holds to, since it is what ran", async () => {
    const { hooks, $, setTier, fail } = await sticky();
    setTier("sonnet", 0.9);
    await turn(hooks, $, "g1");
    fail();
    const second = await turn(hooks, $, "g2");
    assert.equal(second.sent.model, "claude-opus-5-5", "the default ran");
    setTier("sonnet", 0.6);
    const third = await turn(hooks, $, "g3");
    assert.equal(third.sent.model, "claude-opus-5-5", "held on the default");
  });

  test("subagents are never held, whatever the main loop runs on", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "h0");
    setTier("sonnet", 0.6);
    const { next, seen } = spawner("agent-s");
    await hooks.get("agent.spawn")!($, spawnOf(), next);
    assert.equal(seen[0]!.model, "claude-sonnet-5-5");
  });

  test("/jev says whether stickiness is on and what the bar is", async () => {
    const { hooks, $ } = await sticky({ JEV_ROUTER_STICKY_CONFIDENCE: "0.6" });
    assert.match((await jev(hooks, $)).text, /sticky\s+on, switch needs 60%/);
  });
});

describe("register: the sticky subcommand", () => {
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    return (await stepOf(hooks, $, { turnId: id })).sent;
  }

  test("/jev sticky turns it on for the session, with no env var set", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "h1");
    await run(hooks, $, "sticky");
    setTier("sonnet", 0.6);
    assert.equal((await turn(hooks, $, "h2")).model, "claude-opus-5-5", "held");
  });

  test("/jev --sticky is the same command, since that is what people type", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "i1");
    await run(hooks, $, "--sticky");
    setTier("sonnet", 0.6);
    assert.equal((await turn(hooks, $, "i2")).model, "claude-opus-5-5");
  });

  test("/jev sticky off turns it back off", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
    });
    await turn(hooks, $, "j1");
    await run(hooks, $, "sticky off");
    setTier("sonnet", 0.6);
    assert.equal(
      (await turn(hooks, $, "j2")).model,
      "claude-sonnet-5-5",
      "switched",
    );
  });

  test("/jev sticky 0.55 sets the bar for the session", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "k1");
    const out = await run(hooks, $, "sticky 0.55");
    assert.match(out.text, /55%/);
    setTier("sonnet", 0.6);
    assert.equal(
      (await turn(hooks, $, "k2")).model,
      "claude-sonnet-5-5",
      "0.6 clears a 0.55 bar",
    );
  });

  test("the env var is the session’s starting value, and the command overrides it", async () => {
    const { hooks, $ } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      JEV_ROUTER_STICKY_CONFIDENCE: "0.9",
    });
    await hooks.get("session.start")!($, {}, async (e: unknown) => e);
    assert.match(
      (await run(hooks, $, "")).text,
      /sticky\s+on, switch needs 90%/,
    );
    await run(hooks, $, "sticky 0.5");
    assert.match(
      (await run(hooks, $, "")).text,
      /sticky\s+on, switch needs 50%/,
    );
  });

  test("a bar that makes no sense changes nothing and says so", async () => {
    const { hooks, $ } = load();
    await run(hooks, $, "sticky 0.5");
    const out = await run(hooks, $, "sticky 7000");
    assert.match(out.text, /between/);
    assert.match((await run(hooks, $, "")).text, /switch needs 50%/);
  });
});

describe("register: /jev", () => {
  test("the report lists the ladder, the floor and the Fable block", async () => {
    const { hooks, $ } = load();
    const text = (await jev(hooks, $)).text;
    assert.match(text, /ladder\s+haiku\s+claude-haiku-5-5\s+medium–high/);
    assert.match(text, /sonnet\s+claude-sonnet-5-5\s+medium–max/);
    assert.match(
      text,
      /opus\s+claude-opus-5-5\s+medium–max {2}\(default: high\)/,
    );
    assert.match(
      text,
      /floor\s+a pick needs 50% \(default\) of Jev's probability on its model or cheaper/,
    );
    assert.match(text, /blocked\s+fable/);
  });
});

describe("register: the Fable setting", () => {
  const offeredIn = (body: {
    questions: Record<string, { criteria: Record<string, string> }>;
  }) => familiesIn(body);

  test("never, the default, does not offer Fable to Jev", async () => {
    const { hooks, $, asked } = load();
    await start(hooks, $, { text: "x", turnId: "nv" });
    assert.ok(!offeredIn(asked[0]!).includes("fable"));
    assert.ok(offeredIn(asked[0]!).includes("opus"));
  });

  test("hardest offers Fable, and caps a shaky pick to Opus Max, marked capped:fable", async () => {
    const { hooks, $, asked, setTier } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "hardest", fableConfidence: 0.8 },
    );
    setTier("fable", 0.7);
    await start(hooks, $, { text: "x", turnId: "hs" });
    assert.ok(offeredIn(asked[0]!).includes("fable"));
    const { sent, text } = await stepOf(hooks, $, { turnId: "hs" });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "max" },
    );
    // 70% on Fable is short of the 0.8 bar; what runs has 30% behind it.
    assert.match(text, /^> ✳️ `opus·max` · 30% · capped:fable ·/);
    assert.match(text, /jev {2}opus·max · 30% · capped:fable/);
  });

  test("hardest takes a confident Fable pick", async () => {
    const { hooks, $, setTier } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "hardest", fableConfidence: 0.8 },
    );
    setTier("fable", 0.9);
    await start(hooks, $, { text: "x", turnId: "hc" });
    const { sent, text } = await stepOf(hooks, $, { turnId: "hc" }, () =>
      answeredBy("claude-fable-5-1"),
    );
    assert.equal(sent.model, "claude-fable-5-1");
    assert.match(text, /`fable·high` · 100%/);
    assert.match(text, /claude-fable-5-1 ✓/);
  });

  test("hardest gates a subagent's Fable pick the same way", async () => {
    const { hooks, $, setTier } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "hardest" },
    );
    setTier("fable", 0.6);
    const { next, seen } = spawner("hs-agent");
    await hooks.get("agent.spawn")!($, spawnOf(), next);
    assert.equal(seen[0]!.model, "claude-opus-5-5");
    const { sent } = await stepOf(hooks, $, {
      turnId: "hs-s",
      agentId: "hs-agent",
    });
    assert.equal(sent.effort, "max");
  });

  test("hardest still clamps a Fable request nobody routed", async () => {
    const { hooks, $ } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "hardest" },
    );
    const main = await stepOf(hooks, $, {
      turnId: "never-started",
      model: "claude-fable-5-1",
    });
    assert.equal(main.sent.model, "claude-opus-5-5");

    const { next, seen } = spawner("hs-fork");
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ fork: true, subagentType: "fork", model: "claude-fable-5-1" }),
      next,
    );
    assert.equal(seen[0]!.model, "claude-opus-5-5");
  });

  test("open offers Fable and lets an explicit Fable request through", async () => {
    const { hooks, $, asked, setShares } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "open" },
    );
    // Fable is the top of the order under open: 60% on it, and only 40%
    // saying Opus or cheaper will do.
    setShares({ sonnet: 0.3, opus: 0.1, fable: 0.6 });
    await start(hooks, $, { text: "x", turnId: "op" });
    assert.ok(offeredIn(asked[0]!).includes("fable"));
    assert.match(asked[0]!.questions.route!.criteria.fable_high!, /[Pp]lanning/);
    const routed = await stepOf(hooks, $, { turnId: "op" });
    assert.equal(
      routed.sent.model,
      "claude-fable-5-1",
      "Fable is an ordinary family under open, the top of the order",
    );

    const unrouted = await stepOf(hooks, $, {
      turnId: "never-started",
      model: "claude-fable-5-1",
      effort: "xhigh",
    });
    assert.deepEqual(
      { model: unrouted.sent.model, effort: unrouted.sent.effort },
      { model: "claude-fable-5-1", effort: "xhigh" },
    );

    const e = spawnOf({
      fork: true,
      subagentType: "fork",
      model: "claude-fable-5-1",
    });
    const { next, seen } = spawner("op-fork");
    await hooks.get("agent.spawn")!($, e, next);
    assert.equal(seen[0], e);
  });

  test("the env var outranks the option", async () => {
    const { hooks, $, asked } = load(
      { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_FABLE: "NEVER" },
      { fable: "open" },
    );
    await start(hooks, $, { text: "x", turnId: "ev" });
    assert.ok(!offeredIn(asked[0]!).includes("fable"));
    const { sent } = await stepOf(hooks, $, {
      turnId: "ghost",
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.match((await jev(hooks, $)).text, /fable\s+never \(env\)/);
  });

  test("the floor is read from the option when no env var is set", async () => {
    const { hooks, $, setTier } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { minConfidence: 0.2 },
    );
    setTier("haiku", 0.3);
    await start(hooks, $, { text: "x", turnId: "fo" });
    const { sent } = await stepOf(hooks, $, { turnId: "fo" });
    assert.equal(sent.model, "claude-haiku-5-5");
    assert.match(
      (await jev(hooks, $)).text,
      /floor\s+a pick needs 20% \(option\) of Jev's probability/,
    );
  });

  test("/jev shows the ladder actually offered, Fable on it under hardest", async () => {
    const { hooks, $ } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "hardest" },
    );
    const text = (await jev(hooks, $)).text;
    assert.match(
      text,
      /fable\s+hardest \(option\) — a pick needs 75% \(default\)/,
    );
    assert.match(text, /fable\s+claude-fable-5-1\s+medium–max/);
  });
});

describe("register: subagent routing off", () => {
  const off = () =>
    load({ AI_GATEWAY_API_KEY: "gw-key" }, { routeSubagents: false });

  test("a spawn is not asked about and runs on what it was given", async () => {
    const { hooks, $, asked } = off();
    const e = spawnOf({ model: "claude-sonnet-5-5" });
    const { next, seen } = spawner("ro-1", async () => {
      await start(hooks, $, {
        text: e.prompt,
        turnId: "ro-t",
        agentId: "ro-1",
      });
    });
    await hooks.get("agent.spawn")!($, e, next);
    assert.equal(seen[0], e);
    const { sent } = await stepOf(hooks, $, {
      turnId: "ro-t",
      agentId: "ro-1",
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "medium" },
    );
    assert.equal(asked.length, 0);
    assert.match((await jev(hooks, $)).text, /agents\s+not routed.*\(option\)/);
  });

  test("the Fable guard still holds on them", async () => {
    const { hooks, $ } = off();
    const { next, seen } = spawner("ro-2");
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ model: "claude-fable-5-1" }),
      next,
    );
    assert.equal(seen[0]!.model, "claude-opus-5-5");
    const { sent } = await stepOf(hooks, $, {
      turnId: "ro-2t",
      agentId: "ro-2",
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-opus-5-5");
  });

  test("a loop nobody spawned is not asked about either", async () => {
    const { hooks, $, asked } = off();
    await start(hooks, $, {
      text: "Do the thing.",
      turnId: "ro-u",
      agentId: "skill-1",
    });
    assert.equal(asked.length, 0);
  });

  test("the main loop is still routed", async () => {
    const { hooks, $, asked } = off();
    await start(hooks, $, { text: "x", turnId: "ro-m" });
    assert.equal(asked.length, 1);
  });

  test("JEV_ROUTER_SUBAGENTS turns it off too", async () => {
    const { hooks, $, asked } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_SUBAGENTS: "no",
    });
    await hooks.get("agent.spawn")!($, spawnOf(), spawner("ro-3").next);
    assert.equal(asked.length, 0);
  });
});

describe("register: a loop with no spawn", () => {
  test("its first turn.start asks Jev about its text, as a subagent, and its steps get the answer", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("sonnet", 0.85);
    await start(hooks, $, {
      text: "Summarize the changelog.",
      turnId: "sk-t",
      agentId: "agent-1",
    });
    assert.equal(asked.length, 1);
    assert.match(asked[0]!.questions.route!.instructions, /subagent/);
    assert.equal(stateOf(asked[0]!).brief, "Summarize the changelog.");

    const { sent, text } = await stepOf(hooks, $, {
      turnId: "sk-t",
      agentId: "agent-1",
      model: "claude-opus-5-5",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "high" },
    );
    assert.equal(text, "reply", "nothing in a subagent's reply");

    // Woken again later: the same answer, not a second question.
    await start(hooks, $, {
      text: "And the README.",
      turnId: "sk-t2",
      agentId: "agent-1",
    });
    assert.equal(asked.length, 1);
    assert.match(
      (await jev(hooks, $)).text,
      /sonnet·high 0\.85 {2}\[agent:general-purpose\] Review library-sync cluster/,
    );
  });

  test("a loop with no text is left alone", async () => {
    const { hooks, $, asked } = load();
    await start(hooks, $, { text: "", turnId: "sk-e", agentId: "agent-z" });
    assert.equal(asked.length, 0);
  });
});

describe("register: the prompt handoff", () => {
  test("concurrent spawns with one prompt each get their own decision, not a sibling's", async () => {
    const { hooks, $, asked, setTier } = load();
    const prompt = "Look at src/auth.ts.";
    const sent: Record<string, Sent> = {};
    // Each step arrives on the model its spawn sent the agent down on, as
    // an engine's would.
    const step = async (agentId: string, model: unknown) => {
      sent[agentId] = (
        await stepOf(hooks, $, {
          turnId: `${agentId}-t`,
          agentId,
          model,
          effort: "high",
        })
      ).sent;
    };

    setTier("opus", 0.95, "max");
    const audit = spawner("audit", async () => {
      // A second spawn with the same prompt goes down while the first is
      // still going, and its loop starts first.
      setTier("haiku", 0.95, 0);
      const todos = spawner("todos", async () => {
        await start(hooks, $, {
          text: prompt,
          turnId: "todos-t",
          agentId: "todos",
        });
        await step("todos", todos.seen[0]!.model);
      });
      await hooks.get("agent.spawn")!(
        $,
        spawnOf({ prompt, description: "list TODOs", subagentType: "Explore" }),
        todos.next,
      );
      await start(hooks, $, {
        text: prompt,
        turnId: "audit-t",
        agentId: "audit",
      });
      await step("audit", audit.seen[0]!.model);
    });
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt, description: "security audit" }),
      audit.next,
    );

    assert.equal(asked.length, 2, "each spawn asked once, neither loop again");
    assert.deepEqual(
      { model: sent.audit!.model, effort: sent.audit!.effort },
      { model: "claude-opus-5-5", effort: "max" },
      "the audit runs on its own rung",
    );
    assert.deepEqual(
      { model: sent.todos!.model, effort: sent.todos!.effort },
      { model: "claude-haiku-5-5", effort: "medium" },
      "and the TODO list on its",
    );
  });

  test("a listed loop finds its own entry by its type and description", async () => {
    const { hooks, $, setTier, rows } = load();
    const prompt = "Look at src/session.ts.";
    rows.push({
      id: "todos-2",
      type: "Explore",
      description: "list TODOs",
      status: "running",
    });
    let early: Sent = {};
    setTier("opus", 0.95, "max");
    const audit = spawner("audit-2", async () => {
      setTier("haiku", 0.95, 0);
      const todos = spawner("todos-2", async () => {
        await start(hooks, $, {
          text: prompt,
          turnId: "todos-2-t",
          agentId: "todos-2",
        });
        // No model on the step to go by: the turn.start bound it.
        early = (
          await stepOf(hooks, $, { turnId: "todos-2-t", agentId: "todos-2" })
        ).sent;
      });
      await hooks.get("agent.spawn")!(
        $,
        spawnOf({ prompt, description: "list TODOs", subagentType: "Explore" }),
        todos.next,
      );
    });
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt, description: "security audit" }),
      audit.next,
    );
    assert.deepEqual(
      { model: early.model, effort: early.effort },
      { model: "claude-haiku-5-5", effort: "medium" },
    );
    const late = await stepOf(hooks, $, {
      turnId: "audit-2-t",
      agentId: "audit-2",
    });
    assert.equal(late.sent.effort, "max");
  });

  test("a fork and a routed sibling with one prompt do not swap", async () => {
    const { hooks, $, asked, setTier, transcripts } = load();
    const prompt = "Look into the failing build.";
    const sent: Record<string, Sent> = {};
    transcripts.set("routed-x", [{ role: "user", text: prompt }]);
    setTier("haiku", 0.95, 0);
    const routed = spawner("routed-x", async () => {
      const fork = spawner("fork-x", async () => {
        await start(hooks, $, {
          text: prompt,
          turnId: "fork-x-t",
          agentId: "fork-x",
        });
        // A fork's steps arrive on its parent's model.
        sent.fork = (
          await stepOf(hooks, $, {
            turnId: "fork-x-t",
            agentId: "fork-x",
            model: "claude-opus-5-5",
            effort: "high",
          })
        ).sent;
      });
      await hooks.get("agent.spawn")!(
        $,
        spawnOf({ prompt, fork: true, subagentType: "fork" }),
        fork.next,
      );
      sent.routed = (
        await stepOf(hooks, $, {
          turnId: "routed-x-t",
          agentId: "routed-x",
          model: "claude-haiku-5-5",
        })
      ).sent;
    });
    await hooks.get("agent.spawn")!($, spawnOf({ prompt }), routed.next);

    assert.deepEqual(
      { model: sent.fork!.model, effort: sent.fork!.effort },
      { model: "claude-opus-5-5", effort: "high" },
      "the fork keeps its parent's model and cache",
    );
    assert.deepEqual(
      { model: sent.routed!.model, effort: sent.routed!.effort },
      { model: "claude-haiku-5-5", effort: "medium" },
    );
    assert.equal(asked.length, 1);
  });

  test("a loop that cannot tell its entry from a sibling's waits for its spawn's answer", async () => {
    const { hooks, $, asked, setTier } = load();
    const prompt = "Judge it again.";
    setTier("haiku", 0.95, 0);
    const first = spawner("judge-c", async () => {
      setTier("sonnet", 0.95);
      const second = spawner("judge-d", async () => {
        await start(hooks, $, {
          text: prompt,
          turnId: "judge-d-t",
          agentId: "judge-d",
        });
      });
      await hooks.get("agent.spawn")!($, spawnOf({ prompt }), second.next);
    });
    // judge-c's loop only starts once its spawn has answered.
    await hooks.get("agent.spawn")!($, spawnOf({ prompt }), first.next);
    await start(hooks, $, {
      text: prompt,
      turnId: "judge-c-t",
      agentId: "judge-c",
    });

    const c = await stepOf(hooks, $, {
      turnId: "judge-c-t",
      agentId: "judge-c",
    });
    const d = await stepOf(hooks, $, {
      turnId: "judge-d-t",
      agentId: "judge-d",
    });
    assert.equal(asked.length, 2);
    assert.equal(c.sent.model, "claude-haiku-5-5", "judge-c's own answer");
    assert.equal(d.sent.model, "claude-sonnet-5-5", "judge-d's own answer");
  });

  test("siblings that would run alike may take each other's entry", async () => {
    const { hooks, $, asked, setTier } = load();
    const prompt = "Judge it a third time.";
    setTier("sonnet", 0.95);
    const sent: Record<string, string | undefined> = {};
    const first = spawner("judge-e", async () => {
      const second = spawner("judge-f", async () => {
        await start(hooks, $, {
          text: prompt,
          turnId: "judge-f-t",
          agentId: "judge-f",
        });
        sent.f = (
          await stepOf(hooks, $, { turnId: "judge-f-t", agentId: "judge-f" })
        ).sent.effort;
      });
      await hooks.get("agent.spawn")!($, spawnOf({ prompt }), second.next);
    });
    await hooks.get("agent.spawn")!($, spawnOf({ prompt }), first.next);
    await start(hooks, $, {
      text: prompt,
      turnId: "judge-e-t",
      agentId: "judge-e",
    });
    sent.e = (
      await stepOf(hooks, $, { turnId: "judge-e-t", agentId: "judge-e" })
    ).sent.effort;
    assert.deepEqual(sent, { f: "high", e: "high" });
    assert.equal(asked.length, 2);
  });

  test("a fork with a prompt a finished spawn used does not inherit its decision", async () => {
    const { hooks, $, asked, setTier, transcripts } = load();
    const prompt = "Look into the failing build.";
    setTier("haiku", 0.95, 0);
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt }),
      spawner("routed-1").next,
    );

    transcripts.set("fork-9", [{ role: "user", text: prompt }]);
    const fork = spawner("fork-9", async () => {
      await start(hooks, $, {
        text: prompt,
        turnId: "fork-9-t",
        agentId: "fork-9",
      });
    });
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt, fork: true, subagentType: "fork" }),
      fork.next,
    );
    const { sent } = await stepOf(hooks, $, {
      turnId: "fork-9-t",
      agentId: "fork-9",
      model: "claude-opus-5-5",
      effort: "high",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "high" },
      "kept the parent's model",
    );
    assert.equal(asked.length, 1, "nor was the fork asked about");
    assert.match((await jev(hooks, $)).text, /unrouted — \[agent\] fork-9/);
  });

  test("a loop starting after its spawn answered takes nothing from the queue", async () => {
    const { hooks, $, asked, setTier, transcripts } = load();
    const prompt = "Count the TODOs.";
    setTier("haiku", 0.95, 0);
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt }),
      spawner("cnt-1").next,
    );
    // A stranger whose transcript happens to open with the same prompt.
    transcripts.set("stranger", [{ role: "user", text: prompt }]);
    const { sent } = await stepOf(hooks, $, {
      turnId: "str-t",
      agentId: "stranger",
      model: "claude-opus-5-5",
    });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(asked.length, 1);
  });
});

describe("register: a fan-out larger than the old caches", () => {
  test("the turn that launched forty-odd workflow agents keeps its decision, footer and usage", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("opus", 0.9, "max");
    await start(hooks, $, { text: "run the review workflow", turnId: "boss" });
    const launch = await stepOf(hooks, $, { turnId: "boss" }, () =>
      answeredBy("claude-opus-5-5", "tool_use", 1000),
    );
    assert.equal(launch.sent.effort, "max");

    // Every agent spawned and started before any of them steps or ends: the
    // whole fan-out in flight at once, as a real one is. With the old limit
    // of 32 the boss turn and the first agents fell out while still running.
    setTier("sonnet", 0.9, "medium");
    const N = 45;
    for (let i = 0; i < N; i++) {
      const id = `wf-${i}`;
      const prompt = `Review file ${i}.`;
      await hooks.get("agent.spawn")!(
        $,
        spawnOf({ prompt, workflow: { runId: "wf_1", agentIndex: i } }),
        spawner(id).next,
      );
      await start(hooks, $, { text: prompt, turnId: `${id}-t`, agentId: id });
    }
    assert.equal(asked.length, N + 1, "one ask per agent, and the boss's");

    for (let i = 0; i < N; i++) {
      const id = `wf-${i}`;
      const { sent } = await stepOf(hooks, $, {
        turnId: `${id}-t`,
        agentId: id,
        model: "claude-sonnet-5-5",
      });
      assert.equal(sent.effort, "medium", id);
    }

    const last = await stepOf(hooks, $, { turnId: "boss", index: 1 }, () =>
      answeredBy("claude-opus-5-5", "end_turn", 3000),
    );
    assert.deepEqual(
      { model: last.sent.model, effort: last.sent.effort },
      { model: "claude-opus-5-5", effort: "max" },
      "still its own decision",
    );
    assert.match(last.text, /jev {2}opus·max · 100%/, "its footer");
    assert.match(last.text, /22k in/, "both steps' usage");

    const first = await stepOf(hooks, $, {
      turnId: "wf-0-t",
      agentId: "wf-0",
      index: 1,
      model: "claude-sonnet-5-5",
    });
    assert.equal(
      first.sent.effort,
      "medium",
      "the first agent keeps its effort",
    );

    // One woken for another turn after its first ended still has it too,
    // and is not asked about again.
    await complete(hooks, $, "wf-1-t", "wf-1");
    await start(hooks, $, {
      text: "Once more.",
      turnId: "wf-1-t2",
      agentId: "wf-1",
    });
    const woken = await stepOf(hooks, $, {
      turnId: "wf-1-t2",
      agentId: "wf-1",
      model: "claude-sonnet-5-5",
    });
    assert.equal(woken.sent.effort, "medium");
    assert.equal(asked.length, N + 1, "nobody was asked about twice");
  });

  test("a finished turn lets go of its decision", async () => {
    const { hooks, $, setTier } = load();
    setTier("haiku", 0.95, 0);
    await start(hooks, $, { text: "x", turnId: "done" });
    await stepOf(hooks, $, { turnId: "done" });
    await complete(hooks, $, "done");
    const { sent } = await stepOf(hooks, $, {
      turnId: "done",
      model: "claude-sonnet-5-5",
    });
    assert.equal(sent.model, "claude-sonnet-5-5", "nothing left to apply");
  });
});

describe("register: loops the router never saw spawn", () => {
  test("a teammate woken with a one-line message is not asked about on it", async () => {
    const { hooks, $, asked, rows } = load();
    rows.push({
      id: "mate-1",
      type: "teammate",
      description: "scout",
      status: "idle",
      teammateId: "scout@team",
    });
    await start(hooks, $, {
      text: "tests pass now, go on",
      turnId: "mate-t",
      agentId: "mate-1",
    });
    assert.equal(asked.length, 0, "a wake message is not the task");
    const { sent } = await stepOf(hooks, $, {
      turnId: "mate-t",
      agentId: "mate-1",
      model: "claude-opus-5-5",
      effort: "high",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
    assert.match(
      (await jev(hooks, $)).text,
      /unrouted — \[agent:teammate\] scout/,
    );
  });

  test("an unknown teammate is still under the Fable guard", async () => {
    const { hooks, $, rows } = load();
    rows.push({
      id: "mate-f",
      type: "teammate",
      description: "scout",
      status: "idle",
      teammateId: "scout@team",
    });
    await start(hooks, $, { text: "go on", turnId: "mf-t", agentId: "mate-f" });
    const { sent } = await stepOf(hooks, $, {
      turnId: "mf-t",
      agentId: "mate-f",
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-opus-5-5");
  });

  test("a loop the list does not name is not asked about either", async () => {
    const { hooks, $, asked } = load();
    await start(hooks, $, {
      text: "Retry: review file 3.",
      turnId: "gh-t",
      agentId: "wf-retry-3",
    });
    assert.equal(asked.length, 0);
  });
});

describe("register: a reload", () => {
  test("a teammate routed before a reload keeps its rung on the message that wakes it", async () => {
    const before = load();
    before.setTier("opus", 0.9);
    const { next } = spawner("mate-2");
    await before.hooks.get("agent.spawn")!(
      before.$,
      spawnOf({ isTeammate: true, subagentType: "teammate", name: "scout" }),
      next,
    );
    assert.equal(before.asked.length, 1);

    // Changing the Fable picker reloads the module with new options.
    const after = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { fable: "hardest" },
      before.held,
    );
    after.setTier("haiku", 0.99);
    await start(after.hooks, after.$, {
      text: "tests pass now, go on",
      turnId: "mate-2-t2",
      agentId: "mate-2",
    });
    assert.equal(after.asked.length, 0, "not asked again");
    const { sent } = await stepOf(after.hooks, after.$, {
      turnId: "mate-2-t2",
      agentId: "mate-2",
      model: "claude-opus-5-5",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
  });

  test("an agent kept in the old fixed-rung shape survives the reload that upgrades the module", async () => {
    // What a 0.2 copy wrote to $.state: rung names for tiers and marks.
    const kept = (tier: string, effort: string, mark?: string) => {
      const decision = {
        tier,
        model: "claude-sonnet-5-5",
        effort,
        confidence: 0.8,
        ...(mark !== undefined ? { held: mark } : {}),
      };
      return {
        decision,
        attempt: {
          prompt: "scout",
          ms: 400,
          kind: "agent",
          agent: { type: "teammate", label: "scout" },
          decision,
        },
      };
    };
    const held = new Map<string, unknown>([
      ["jev-router/agents/old-sm", kept("sonnet-medium", "medium", "opus-high")],
      ["jev-router/agents/old-om", kept("opus-max", "max")],
      ["jev-router/agents/old-h", kept("haiku", "low")],
      ["jev-router/agents/old-bad", kept("gpt-5", "high")],
    ]);
    const { hooks, $, asked, setTier } = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      undefined,
      held,
    );
    setTier("opus", 0.9);

    const run = async (agentId: string) => {
      await start(hooks, $, {
        text: "go on",
        turnId: `${agentId}-t`,
        agentId,
      });
      const { sent } = await stepOf(hooks, $, {
        turnId: `${agentId}-t`,
        agentId,
        model: "claude-opus-5-5",
        effort: "high",
      });
      return { model: sent.model, effort: sent.effort };
    };

    assert.deepEqual(await run("old-sm"), {
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    assert.deepEqual(await run("old-om"), {
      model: "claude-opus-5-5",
      effort: "max",
    });
    assert.deepEqual(
      await run("old-h"),
      { model: "claude-haiku-5-5", effort: "medium" },
      "haiku at low comes back clamped to medium",
    );
    assert.equal(asked.length, 0, "none of the three was asked about again");

    // A kept decision on a tier neither ladder knows is dropped, not trusted:
    // the agent's step goes as the engine sent it.
    assert.deepEqual(await run("old-bad"), {
      model: "claude-opus-5-5",
      effort: "high",
    });
  });

  test("/jev off, quiet and sticky survive a reload", async () => {
    const before = load();
    const run = (args: string) =>
      before.hooks.get('command.run:{"command":"jev"}')!(before.$, { args });
    await run("quiet");
    await run("sticky 0.6");
    await run("off");

    const after = load({ AI_GATEWAY_API_KEY: "gw-key" }, {}, before.held);
    await start(after.hooks, after.$, { text: "x", turnId: "rl" });
    assert.equal(after.asked.length, 0, "still off");
    const report = (await jev(after.hooks, after.$)).text;
    assert.match(report, /routing\s+off \(\/jev on\)/);
    assert.match(report, /announce\s+off/);
    assert.match(report, /sticky\s+on, switch needs 60%/);
  });
});

describe("register: a step the engine moved to a fallback model", () => {
  test("goes on the engine's model, not back to the decision's, its effort banded", async () => {
    const { hooks, $, setTier } = load();
    setTier("sonnet", 0.9);
    await start(hooks, $, { text: "rename foo", turnId: "fb" });
    const first = await stepOf(hooks, $, {
      turnId: "fb",
      model: "claude-opus-5-5",
    });
    assert.equal(first.sent.model, "claude-sonnet-5-5");

    const retry = await stepOf(hooks, $, {
      turnId: "fb",
      index: 1,
      model: "claude-haiku-5-5",
      effort: "low",
    });
    // The model is the engine's; the effort is held to Haiku's band.
    assert.deepEqual(
      { model: retry.sent.model, effort: retry.sent.effort },
      { model: "claude-haiku-5-5", effort: "medium" },
    );

    // Back on the turn's own model: the decision again.
    const after = await stepOf(hooks, $, {
      turnId: "fb",
      index: 2,
      model: "claude-opus-5-5",
    });
    assert.equal(after.sent.model, "claude-sonnet-5-5");
  });

  test("a fallback to Fable is still under the guard", async () => {
    const { hooks, $, setTier } = load();
    setTier("sonnet", 0.9);
    const { next } = spawner("fbs");
    await hooks.get("agent.spawn")!($, spawnOf(), next);
    await stepOf(hooks, $, {
      turnId: "fbs-t",
      agentId: "fbs",
      model: "claude-sonnet-5-5",
    });
    const { sent } = await stepOf(hooks, $, {
      turnId: "fbs-t",
      agentId: "fbs",
      index: 1,
      model: "claude-fable-5-1",
    });
    assert.equal(sent.model, "claude-opus-5-5");
  });
});

describe("register: a Fable setting changed mid-session", () => {
  test("an agent routed to Fable under open is held to never from its next step", async () => {
    const env: Record<string, string> = {
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_FABLE: "open",
    };
    const { hooks, $, setTier } = load(env);
    setTier("fable", 0.9);
    const { next, seen } = spawner("fab-1");
    await hooks.get("agent.spawn")!($, spawnOf(), next);
    assert.equal(seen[0]!.model, "claude-fable-5-1");
    const open = await stepOf(hooks, $, {
      turnId: "fab-t",
      agentId: "fab-1",
      model: "claude-fable-5-1",
    });
    assert.equal(open.sent.model, "claude-fable-5-1");

    env.JEV_ROUTER_FABLE = "never";
    const never = await stepOf(hooks, $, {
      turnId: "fab-t",
      agentId: "fab-1",
      index: 1,
      model: "claude-fable-5-1",
    });
    assert.deepEqual(
      { model: never.sent.model, effort: never.sent.effort },
      { model: "claude-opus-5-5", effort: "max" },
      "capped to the ceiling",
    );

    // Under hardest, a pick below the bar is capped too, and one above it
    // still runs on Fable.
    env.JEV_ROUTER_FABLE = "hardest";
    env.JEV_ROUTER_FABLE_CONFIDENCE = "0.95";
    const shaky = await stepOf(hooks, $, {
      turnId: "fab-t",
      agentId: "fab-1",
      index: 2,
      model: "claude-fable-5-1",
    });
    assert.equal(shaky.sent.effort, "max");
    env.JEV_ROUTER_FABLE_CONFIDENCE = "0.8";
    const sure = await stepOf(hooks, $, {
      turnId: "fab-t",
      agentId: "fab-1",
      index: 3,
      model: "claude-fable-5-1",
    });
    assert.equal(sure.sent.model, "claude-fable-5-1");
  });
});

describe("register: a continuation", () => {
  test("runs on what the last turn ran on, without asking Jev", async () => {
    const { hooks, $, asked, setTier } = load();
    setTier("sonnet", 0.9);
    await start(hooks, $, { text: "rename foo to bar", turnId: "c1" });
    await stepOf(hooks, $, { turnId: "c1" });
    await complete(hooks, $, "c1");

    await start(hooks, $, { text: "", turnId: "c2" });
    assert.equal(asked.length, 1, "nothing to ask about");
    const { sent, text } = await stepOf(hooks, $, {
      turnId: "c2",
      model: "claude-opus-5-5",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "high" },
    );
    assert.match(text, /^> ✳️ `sonnet·high` · 90% · continue · 0ms/);
    assert.doesNotMatch(text, /fallback/);
  });

  test("with no turn before it, runs on what it was given, Fable aside", async () => {
    const { hooks, $, asked } = load();
    await start(hooks, $, { text: "", turnId: "c0" });
    assert.equal(asked.length, 0);
    const plain = await stepOf(hooks, $, {
      turnId: "c0",
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    assert.deepEqual(
      { model: plain.sent.model, effort: plain.sent.effort },
      { model: "claude-sonnet-5-5", effort: "medium" },
    );
    assert.match(plain.text, /^> ⚠️ `unrouted` · empty prompt/);

    await start(hooks, $, { text: "", turnId: "c0f" });
    const fable = await stepOf(hooks, $, {
      turnId: "c0f",
      model: "claude-fable-5-1",
    });
    assert.equal(fable.sent.model, "claude-opus-5-5");
  });
});

describe("register: a workflow run whose spawns carry a placeholder", () => {
  const PLACEHOLDER = "[workflow agent prompt]";
  const wf = (i: number, description: string) =>
    spawnOf({
      prompt: PLACEHOLDER,
      description,
      workflow: { runId: "wf_9", agentIndex: i },
      tool_use_id: "",
    });

  test("each agent is asked about the prompt its loop actually starts with", async () => {
    const { hooks, $, asked } = load();
    const tasks = [
      "Audit src/auth.ts for injection.",
      "List the TODOs in src/.",
      "Rename foo to bar in util.ts.",
    ];
    for (const [i, task] of tasks.entries()) {
      await hooks.get("agent.spawn")!(
        $,
        wf(i + 1, `task ${i + 1}`),
        spawner(`ph-${i}`).next,
      );
      await start(hooks, $, {
        text: task,
        turnId: `ph-${i}-t`,
        agentId: `ph-${i}`,
      });
    }
    // The first spawn could not know its prompt was a placeholder, so it was
    // asked about once blind and again at its first turn; the rest wait.
    const states = asked.map((b) => JSON.stringify(b.state));
    assert.equal(states.filter((s) => s.includes(PLACEHOLDER)).length, 1);
    for (const task of tasks) {
      assert.equal(
        states.filter((s) => s.includes(task)).length,
        1,
        `asked once about ${task}`,
      );
    }
    for (let i = 0; i < tasks.length; i++) {
      const { sent } = await stepOf(hooks, $, {
        turnId: `ph-${i}-t`,
        agentId: `ph-${i}`,
      });
      assert.equal(sent.effort, "high", `ph-${i} is routed`);
    }
  });

  test("an agent whose loop starts before its spawn answers is routed on its own text", async () => {
    const { hooks, $, asked } = load();
    await hooks.get("agent.spawn")!($, wf(1, "first"), spawner("pr-0").next);
    await start(hooks, $, {
      text: "Task zero.",
      turnId: "pr-0-t",
      agentId: "pr-0",
    });
    const before = asked.length;
    const { next } = spawner("pr-1", async () => {
      await start(hooks, $, {
        text: "Count the lines of README.md.",
        turnId: "pr-1-t",
        agentId: "pr-1",
      });
    });
    await hooks.get("agent.spawn")!($, wf(2, "second"), next);
    assert.equal(asked.length, before + 1, "asked once, at its first turn");
    assert.equal(stateOf(asked.at(-1)!).brief, "Count the lines of README.md.");
    assert.equal(stateOf(asked.at(-1)!).from_workflow, true);
  });
});

describe("register: the default model and the bands are settings", () => {
  const offeredIn = (body: {
    questions: Record<string, { criteria: Record<string, string> }>;
  }) => familiesIn(body);

  /** One main-loop turn, and what its step was sent as. */
  const turn = async (
    kit: ReturnType<typeof load>,
    turnId: string,
    model = "claude-opus-5-5",
  ) => {
    await start(kit.hooks, kit.$, { text: "x", turnId });
    const { sent, text } = await stepOf(kit.hooks, kit.$, { turnId, model });
    return { model: sent.model, effort: sent.effort, text };
  };

  test("a default of Sonnet is where a failed call falls back to", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_DEFAULT_MODEL: "sonnet",
    });
    kit.fail();
    const got = await turn(kit, "fb");
    assert.deepEqual(
      { model: got.model, effort: got.effort },
      { model: "claude-sonnet-5-5", effort: "high" },
    );
    assert.match(
      got.text,
      /^> ⚠️ `sonnet·high` · fallback — gateway said HTTP 500/,
    );
  });

  test("a default of Sonnet does not move the floor: the pick follows Jev's distribution", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_DEFAULT_MODEL: "sonnet",
    });
    // Top choice Haiku with 40%: the median is Sonnet.
    kit.setShares({ haiku: 0.4, sonnet: 0.35, opus: 0.25 });
    const floored = await turn(kit, "fl-h");
    assert.equal(floored.model, "claude-sonnet-5-5");
    assert.match(floored.text, /floored:haiku/);

    // 70% on Opus goes to Opus, whatever the default is.
    kit.setTier("haiku", 0.3, "high");
    const opus = await turn(kit, "fl-o");
    assert.equal(opus.model, "claude-opus-5-5");
    assert.doesNotMatch(opus.text, /floored/);

    assert.match(
      (await jev(kit.hooks, kit.$)).text,
      /floor\s+a pick needs 50% \(default\) of Jev's probability/,
    );
  });

  test("the default model and effort are read from the options too, a subagent's fallback included", async () => {
    const kit = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { defaultModel: "sonnet", defaultEffort: "medium" },
    );
    kit.fail();
    const { next, seen } = spawner("fb-agent");
    await kit.hooks.get("agent.spawn")!(kit.$, spawnOf(), next);
    assert.equal(seen[0]!.model, "claude-sonnet-5-5");
    const { sent } = await stepOf(kit.hooks, kit.$, {
      turnId: "fb-agent-t",
      agentId: "fb-agent",
      model: "claude-sonnet-5-5",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "medium" },
    );
  });

  test("a default of Fable under never is refused: Opus falls back, and /jev says so", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_DEFAULT_MODEL: "fable",
    });
    kit.fail();
    const got = await turn(kit, "ff");
    assert.deepEqual(
      { model: got.model, effort: got.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
    const text = (await jev(kit.hooks, kit.$)).text;
    assert.match(text, /default\s+opus·high — model \(env\)/);
    assert.match(text, /fable can't be the default under never, so opus/);
    assert.ok(!offeredIn(kit.asked[0]!).includes("fable"), "still not offered");
  });

  test("a default of Fable under open is the fallback", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_FABLE: "open",
      JEV_ROUTER_DEFAULT_MODEL: "fable",
    });
    kit.fail();
    const got = await turn(kit, "fo");
    assert.equal(got.model, "claude-fable-5-1");
  });

  test("a narrowed Opus band caps a max pick, and the Fable cap with it", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_OPUS_EFFORT: "high",
      JEV_ROUTER_FABLE: "hardest",
    });
    kit.setTier("opus", 0.9, 4);
    const max = await turn(kit, "nb-o");
    assert.deepEqual(
      { model: max.model, effort: max.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
    kit.setTier("fable", 0.6, 4);
    const capped = await turn(kit, "nb-f");
    assert.deepEqual(
      { model: capped.model, effort: capped.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
    assert.match(capped.text, /`opus·high` · 40% · capped:fable/);
    assert.match(
      (await jev(kit.hooks, kit.$)).text,
      /fable\s+hardest \(env\) — a pick needs 75% \(default\) on fable, else opus·high/,
    );
  });

  test("a widened Haiku band lets a low answer run at low", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_HAIKU_EFFORT: "LOW-high",
    });
    kit.setTier("haiku", 0.9, 0);
    const got = await turn(kit, "wb");
    assert.deepEqual(
      { model: got.model, effort: got.effort },
      { model: "claude-haiku-5-5", effort: "low" },
    );
  });

  test("an unreadable band falls through to the option, then the default", async () => {
    const kit = load(
      { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_SONNET_EFFORT: "max-medium" },
      { sonnetEffort: "medium" },
    );
    kit.setTier("sonnet", 0.9, 4);
    const got = await turn(kit, "ub");
    assert.equal(got.effort, "medium", "the inverted env band is skipped");
    assert.match(
      (await jev(kit.hooks, kit.$)).text,
      /sonnet\s+claude-sonnet-5-5\s+medium \(option\)$/m,
    );
  });

  test("a band changed mid-session reaches a subagent's next step, and widening gives the effort back", async () => {
    const env: Record<string, string> = { AI_GATEWAY_API_KEY: "gw-key" };
    const kit = load(env);
    kit.setTier("opus", 0.9, "max");
    const { next } = spawner("band-1");
    await kit.hooks.get("agent.spawn")!(kit.$, spawnOf(), next);
    const step = async (index: number) => {
      const { sent } = await stepOf(kit.hooks, kit.$, {
        turnId: "band-t",
        agentId: "band-1",
        index,
        model: "claude-opus-5-5",
      });
      return sent.effort;
    };
    assert.equal(await step(0), "max");
    env.JEV_ROUTER_OPUS_EFFORT = "medium-high";
    assert.equal(await step(1), "high");
    delete env.JEV_ROUTER_OPUS_EFFORT;
    assert.equal(await step(2), "max");
    assert.equal(kit.asked.length, 1, "never asked again");
  });

  test("a kept decision is clamped into the bands in force after a reload", async () => {
    const decision = {
      tier: "opus-max",
      model: "claude-opus-5-5",
      effort: "max",
      confidence: 0.8,
    };
    const held = new Map<string, unknown>([
      [
        "jev-router/agents/kept-1",
        {
          decision,
          attempt: { prompt: "scout", ms: 400, kind: "agent", decision },
        },
      ],
    ]);
    const kit = load(
      { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_OPUS_EFFORT: "medium-xhigh" },
      undefined,
      held,
    );
    await start(kit.hooks, kit.$, {
      text: "go on",
      turnId: "kept-t",
      agentId: "kept-1",
    });
    const { sent } = await stepOf(kit.hooks, kit.$, {
      turnId: "kept-t",
      agentId: "kept-1",
      model: "claude-opus-5-5",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "xhigh" },
    );
    assert.equal(kit.asked.length, 0);
  });

  test("a Fable request nobody routed goes to the default lifted to Opus, at its effort", async () => {
    for (const [model, effort, want] of [
      ["sonnet", "medium", "medium"],
      ["haiku", "high", "high"],
      ["opus", "xhigh", "xhigh"],
    ] as const) {
      const kit = load({
        AI_GATEWAY_API_KEY: "gw-key",
        JEV_ROUTER_DEFAULT_MODEL: model,
        JEV_ROUTER_DEFAULT_EFFORT: effort,
      });
      const { sent } = await stepOf(kit.hooks, kit.$, {
        turnId: "nobody",
        model: "claude-fable-5-1",
        effort: "max",
      });
      assert.deepEqual(
        { model: sent.model, effort: sent.effort },
        { model: "claude-opus-5-5", effort: want },
        model,
      );
      const { next, seen } = spawner("fork-1");
      await kit.hooks.get("agent.spawn")!(
        kit.$,
        spawnOf({ fork: true, model: "claude-fable-5-1" }),
        next,
      );
      assert.equal(seen[0]!.model, "claude-opus-5-5", model);
      await stepOf(kit.hooks, kit.$, {
        turnId: "fork-t",
        agentId: "fork-1",
        model: "claude-fable-5-1",
      });
      const report = (await jev(kit.hooks, kit.$)).text;
      assert.match(report, new RegExp(`blocked claude-fable-5-1 → opus·${want}`), model);
    }
  });

  test("the default family stays on offer whatever JEV_ROUTER_EXCLUDE says", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_DEFAULT_MODEL: "sonnet",
      JEV_ROUTER_EXCLUDE: "sonnet,haiku,opus",
    });
    await start(kit.hooks, kit.$, { text: "x", turnId: "ex" });
    assert.deepEqual(offeredIn(kit.asked[0]!), ["sonnet", "opus"]);
    assert.match((await jev(kit.hooks, kit.$)).text, /excluded\s+haiku$/m);
  });

  test("/jev shows the effective bands and default, each with where it came from", async () => {
    const kit = load(
      {
        AI_GATEWAY_API_KEY: "gw-key",
        JEV_ROUTER_HAIKU_EFFORT: "low-high",
        JEV_ROUTER_DEFAULT_EFFORT: "xhigh",
      },
      { opusEffort: "high-max" },
    );
    const text = (await jev(kit.hooks, kit.$)).text;
    assert.match(
      text,
      /default\s+opus·xhigh — model \(default\), effort \(env\), for fallbacks/,
    );
    assert.match(
      text,
      /ladder\s+haiku\s+claude-haiku-5-5\s+low–high \(env\)$/m,
    );
    assert.match(text, /^\s+sonnet\s+claude-sonnet-5-5\s+medium–max$/m);
    assert.match(
      text,
      /^\s+opus\s+claude-opus-5-5\s+high–max \(option\) {2}\(default: xhigh\)$/m,
    );
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("/jev says when the default effort was clamped into the default's band", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_DEFAULT_MODEL: "haiku",
      JEV_ROUTER_DEFAULT_EFFORT: "max",
    });
    const text = (await jev(kit.hooks, kit.$)).text;
    assert.match(text, /default\s+haiku·high/);
    assert.match(text, /max is outside haiku's band \(medium–high\), so high/);
    assert.match(text, /floor\s+a pick needs 50%/);
    kit.fail();
    const got = await turn(kit, "hc");
    assert.deepEqual(
      { model: got.model, effort: got.effort },
      { model: "claude-haiku-5-5", effort: "high" },
    );
  });
});

describe("register: steps nobody decided are held to the bands", () => {
  test("a fork keeps its parent's model but not an effort Opus's band refuses", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_OPUS_EFFORT: "medium-high",
    });
    const { next, seen } = spawner("fork-b");
    await kit.hooks.get("agent.spawn")!(kit.$, spawnOf({ fork: true }), next);
    assert.equal(seen[0]!.model, undefined, "the fork's model is left alone");
    const { sent } = await stepOf(kit.hooks, kit.$, {
      turnId: "fork-b-t",
      agentId: "fork-b",
      model: "claude-opus-5-5",
      effort: "max",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-opus-5-5", effort: "high" },
    );
    assert.equal(kit.asked.length, 0);
  });

  test("a session on Haiku at low runs an unrouted step at medium", async () => {
    const kit = load();
    await start(kit.hooks, kit.$, { text: "", turnId: "hl" });
    const { sent } = await stepOf(kit.hooks, kit.$, {
      turnId: "hl",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-haiku-5-5", effort: "medium" },
    );
  });

  test("a numeric effort, no effort, and an unknown model go as they came", async () => {
    const kit = load();
    for (const [model, effort] of [
      ["claude-haiku-5-5", 2048],
      ["claude-haiku-5-5", undefined],
      ["some-other-model", "low"],
    ] as const) {
      const { sent } = await stepOf(kit.hooks, kit.$, {
        turnId: `as-${model}-${effort}`,
        agentId: "stranger",
        model,
        ...(effort !== undefined ? { effort } : {}),
      });
      assert.deepEqual(
        { model: sent.model, effort: sent.effort },
        { model, effort },
      );
    }
  });

  test("off is off: with no key, Haiku at low goes at low", async () => {
    const kit = load({});
    const { sent } = await stepOf(kit.hooks, kit.$, {
      turnId: "off-hl",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    assert.equal(sent.effort, "low");
  });
});

describe("register: what the main loop runs on survives a reload", () => {
  const started = async (held?: Map<string, unknown>) => {
    const kit = load(
      { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" },
      undefined,
      held,
    );
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  test("a shaky switch down after a settings reload is still held", async () => {
    const before = await started();
    before.setTier("opus", 0.9);
    await start(before.hooks, before.$, { text: "x", turnId: "r1" });

    const after = await started(before.held);
    after.setTier("sonnet", 0.6);
    await start(after.hooks, after.$, { text: "y", turnId: "r2" });
    const { sent, text } = await stepOf(after.hooks, after.$, { turnId: "r2" });
    assert.equal(sent.model, "claude-opus-5-5");
    assert.match(text, /held:sonnet/);
  });

  test("a continuation after a reload carries on with the last turn's pick", async () => {
    const before = await started();
    before.setTier("sonnet", 0.9, "medium");
    await start(before.hooks, before.$, { text: "rename it", turnId: "c1" });

    const after = await started(before.held);
    await start(after.hooks, after.$, { text: "", turnId: "c2" });
    const { sent } = await stepOf(after.hooks, after.$, {
      turnId: "c2",
      model: "claude-opus-5-5",
    });
    assert.deepEqual(
      { model: sent.model, effort: sent.effort },
      { model: "claude-sonnet-5-5", effort: "medium" },
    );
    assert.equal(after.asked.length, 0);
  });
});

describe("register: a narrowed band does not stick to a kept agent", () => {
  test("widening the band again after a reload gives back the effort Jev picked", async () => {
    const before = load();
    before.setTier("opus", 0.9, "max");
    const { next } = spawner("wf-1");
    await before.hooks.get("agent.spawn")!(
      before.$,
      spawnOf({ workflow: { runId: "run-1" } }),
      next,
    );

    // Opus narrowed in /config: a reload, with the agent not started yet.
    const narrow = load(
      { AI_GATEWAY_API_KEY: "gw-key" },
      { opusEffort: "medium-high" },
      before.held,
    );
    const prompt = spawnOf().prompt;
    await start(narrow.hooks, narrow.$, {
      text: prompt,
      turnId: "wf-1-t1",
      agentId: "wf-1",
    });
    const narrowed = await stepOf(narrow.hooks, narrow.$, {
      turnId: "wf-1-t1",
      agentId: "wf-1",
      model: "claude-opus-5-5",
    });
    assert.equal(narrowed.sent.effort, "high");

    // Widened again: another reload.
    const wide = load({ AI_GATEWAY_API_KEY: "gw-key" }, undefined, narrow.held);
    await start(wide.hooks, wide.$, {
      text: "go on",
      turnId: "wf-1-t2",
      agentId: "wf-1",
    });
    const widened = await stepOf(wide.hooks, wide.$, {
      turnId: "wf-1-t2",
      agentId: "wf-1",
      model: "claude-opus-5-5",
    });
    assert.equal(widened.sent.effort, "max");
    assert.equal(wide.asked.length, 0);
  });
});

describe("register: Jev is told which family is the default", () => {
  test("a Sonnet default is the catch-all in the criteria Jev is sent", async () => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_DEFAULT_MODEL: "sonnet",
    });
    await start(kit.hooks, kit.$, { text: "x", turnId: "dc" });
    // The catch-all is said once, on the default pair, Sonnet at high
    // (the default effort, inside Sonnet's band), and on no other option.
    const catchAll = (criteria: Record<string, string>) =>
      Object.keys(criteria).filter((p) =>
        /does not clearly fit another option/.test(criteria[p]!),
      );
    const criteria = kit.asked[0]!.questions.route!.criteria;
    assert.deepEqual(catchAll(criteria), ["sonnet_high"]);
    assert.doesNotMatch(criteria.opus_high!, /default|does not clearly fit/i);

    const { next } = spawner("dc-1");
    await kit.hooks.get("agent.spawn")!(kit.$, spawnOf(), next);
    assert.deepEqual(catchAll(kit.asked[1]!.questions.route!.criteria), [
      "sonnet_high",
    ]);
  });
});

describe("register: what Jev is shown", () => {
  /** A main-loop transcript as `$.session.messages()` returns it. */
  const transcript = (request: string) => [
    {
      role: "user",
      text: "<system-reminder>Today is Friday.</system-reminder>add retries to the fetch client",
      toolUses: [],
    },
    {
      role: "assistant",
      text: "Let me read the client.",
      toolUses: [
        {
          tool_use_id: "t1",
          tool: "Read",
          input: { file_path: "/work/app/src/net.ts" },
          text: "export async function get() {}",
        },
      ],
    },
    {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "t1", text: "…", isError: false }],
    },
    {
      role: "assistant",
      text: "> ✳️ `sonnet·high` · 80% · 512ms\n\n---\n\nAdded retries with backoff to src/net.ts.",
      toolUses: [],
    },
    { role: "user", text: request, toolUses: [] },
  ];

  test("a turn is shown with the conversation before it and the files in play", async () => {
    const { hooks, $, asked, setMain, mainReads } = load();
    const request = "now do the same for the upload client";
    setMain(transcript(request));
    await start(hooks, $, { text: request, turnId: "ctx" });
    assert.deepEqual(asked[0]!.state, {
      request,
      recent_conversation: [
        { from: "developer", text: "add retries to the fetch client" },
        { from: "agent", text: "Added retries with backoff to src/net.ts." },
      ],
      files_in_play: ["src/net.ts"],
      continuing: true,
    });
    assert.equal(mainReads(), 1, "one read of the transcript per turn");
  });

  test("the row keeps the typed text, not the state Jev was sent", async () => {
    const { hooks, $, setMain } = load();
    const request = "now do the same for the upload client";
    setMain(transcript(request));
    await start(hooks, $, { text: request, turnId: "row" });
    const report = (await jev(hooks, $)).text;
    assert.match(report, /now do the same for the upload client/);
    assert.doesNotMatch(report, /recent_conversation|"request"/);
  });

  test("a transcript that cannot be read leaves the request alone, and the turn is still routed", async () => {
    const { hooks, $, asked, setMain, setTier } = load();
    setTier("sonnet", 0.9, "high");
    setMain(new Error("transcript unavailable"));
    await start(hooks, $, { text: "rename foo to bar", turnId: "bare" });
    assert.deepEqual(asked[0]!.state, { request: "rename foo to bar" });
    const { sent } = await stepOf(hooks, $, { turnId: "bare" });
    assert.equal(sent.model, "claude-sonnet-5-5");
  });

  test("a directory that cannot be read leaves the paths as they were written", async () => {
    const { hooks, $, asked, setMain, setCwd } = load();
    const request = "now do the same for the upload client";
    setMain(transcript(request));
    setCwd(new Error("no cwd"));
    await start(hooks, $, { text: request, turnId: "abs" });
    assert.deepEqual(
      (asked[0]!.state as { files_in_play?: string[] }).files_in_play,
      ["/work/app/src/net.ts"],
    );
  });

  test("a notification turn is asked about its summary, and is not the developer's request", async () => {
    const { hooks, $, asked } = load();
    await start(hooks, $, { text: "fix the login redirect", turnId: "typed" });
    const envelope =
      "<task-notification><task-id>b1</task-id><summary>Agent \"Audit deps\" completed</summary></task-notification>";
    await start(hooks, $, { text: envelope, turnId: "notice" });
    assert.equal(
      (asked[1]!.state as { request: string }).request,
      'Agent "Audit deps" completed',
    );
    // A thin brief after it is shown beside the typed request, not the
    // notification.
    const { next } = spawner("thin-1");
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt: "Review the diff." }),
      next,
    );
    assert.equal(
      (asked[2]!.state as { parent_request?: string }).parent_request,
      "fix the login redirect",
    );
  });

  test("a thin brief is shown with the developer's request, a full one without, and neither reads the transcript", async () => {
    const { hooks, $, asked, mainReads } = load();
    await start(hooks, $, {
      text: "make the checkout flow handle expired cards",
      turnId: "parent",
    });
    const reads = mainReads();

    const thin = spawner("thin");
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt: "Review the diff for bugs." }),
      thin.next,
    );
    assert.deepEqual(asked[1]!.state, {
      brief: "Review the diff for bugs.",
      task: "Fix flaky retry test",
      agent_type: "general-purpose",
      parent_request: "make the checkout flow handle expired cards",
    });

    const full = spawner("full");
    const brief = `Fix the expired-card path. ${"Context line. ".repeat(40)}`;
    await hooks.get("agent.spawn")!($, spawnOf({ prompt: brief }), full.next);
    assert.equal(
      (asked[2]!.state as { parent_request?: string }).parent_request,
      undefined,
    );

    // A workflow's fan-out: no transcript read for any of its agents.
    for (let i = 0; i < 5; i++) {
      await hooks.get("agent.spawn")!(
        $,
        spawnOf({
          prompt: `Check module ${i}.`,
          workflow: { runId: "wf_ctx", agentIndex: i },
          tool_use_id: "",
        }),
        spawner(`wf-${i}`).next,
      );
    }
    assert.equal(mainReads(), reads, "no transcript read per subagent");
  });

  test("after a reload, thin briefs find the developer's request in the transcript, with one read between them", async () => {
    // A fresh load is a fresh copy of the module: no typed turn seen yet.
    const { hooks, $, asked, setMain, mainReads } = load();
    setMain([
      { role: "user", text: "make the checkout flow handle expired cards", toolUses: [] },
      { role: "assistant", text: "On it.", toolUses: [] },
    ]);
    const full = `Fix the expired-card path. ${"Context line. ".repeat(40)}`;
    await hooks.get("agent.spawn")!($, spawnOf({ prompt: full }), spawner("full").next);
    assert.equal(mainReads(), 0, "a full brief reads nothing");
    for (let i = 0; i < 3; i++) {
      await hooks.get("agent.spawn")!(
        $,
        spawnOf({ prompt: `Check module ${i}.` }),
        spawner(`thin-${i}`).next,
      );
      assert.equal(
        (asked[i + 1]!.state as { parent_request?: string }).parent_request,
        "make the checkout flow handle expired cards",
      );
    }
    assert.equal(mainReads(), 1, "one read for every thin brief");
  });

  test("a teammate's message is nobody typing, and a thin brief keeps the developer's request", async () => {
    const { hooks, $, asked } = load();
    await start(hooks, $, { text: "fix the login redirect", turnId: "typed" });
    await start(hooks, $, {
      text: '<teammate-message teammate_id="t1">API_KEY=sk-test found in logs</teammate-message>',
      turnId: "mate",
    });
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt: "Review the diff." }),
      spawner("thin-mate").next,
    );
    assert.equal(
      (asked[2]!.state as { parent_request?: string }).parent_request,
      "fix the login redirect",
    );
  });

  test("before any typed turn, a thin brief goes alone", async () => {
    const { hooks, $, asked } = load();
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt: "Review the diff." }),
      spawner("lone").next,
    );
    assert.equal(
      (asked[0]!.state as { parent_request?: string }).parent_request,
      undefined,
    );
  });
});

describe("register: the context setting", () => {
  /** A transcript with a request in it, and a file the agent read. */
  const transcript = (request: string) => [
    { role: "user", text: "add retries to the fetch client", toolUses: [] },
    {
      role: "assistant",
      text: "Done: cat .env printed API_KEY=sk-live-123, then I edited src/net.ts.",
      toolUses: [
        {
          tool_use_id: "t1",
          tool: "Read",
          input: { file_path: "/work/app/src/net.ts" },
          text: "",
        },
      ],
    },
    { role: "user", text: request, toolUses: [] },
  ];
  const gw = { AI_GATEWAY_API_KEY: "gw-key" };

  test("under request, a turn sends the request alone and reads neither transcript nor directory", async () => {
    for (const kit of [
      load(gw, { context: "request" }),
      load({ ...gw, JEV_ROUTER_CONTEXT: "request" }),
    ]) {
      const { hooks, $, asked, setMain, mainReads, cwdReads } = kit;
      const request = "now do the same for the upload client";
      setMain(transcript(request));
      await start(hooks, $, { text: request, turnId: "narrow" });
      assert.deepEqual(asked[0]!.state, { request });
      assert.equal(mainReads(), 0, "no transcript read");
      assert.equal(cwdReads(), 0, "no directory read");
      assert.doesNotMatch(JSON.stringify(asked[0]), /sk-live-123|src\/net\.ts/);
    }
  });

  test("under full, the default, the same turn carries its context", async () => {
    const { hooks, $, asked, setMain, mainReads } = load();
    const request = "now do the same for the upload client";
    setMain(transcript(request));
    await start(hooks, $, { text: request, turnId: "wide" });
    const state = asked[0]!.state as Record<string, unknown>;
    assert.ok("recent_conversation" in state);
    assert.deepEqual(state.files_in_play, ["src/net.ts"]);
    assert.equal(state.continuing, true);
    assert.equal(mainReads(), 1);
  });

  test("an env var of full beats an option of request", async () => {
    const { hooks, $, asked, setMain } = load(
      { ...gw, JEV_ROUTER_CONTEXT: "full" },
      { context: "request" },
    );
    const request = "now do the same for the upload client";
    setMain(transcript(request));
    await start(hooks, $, { text: request, turnId: "env" });
    assert.ok("recent_conversation" in (asked[0]!.state as object));
  });

  test("under request, a thin brief goes without the developer's request, its own fields kept", async () => {
    const { hooks, $, asked, mainReads } = load(gw, { context: "request" });
    await start(hooks, $, {
      text: "make the checkout flow handle expired cards",
      turnId: "parent",
    });
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt: "Review the diff for bugs." }),
      spawner("thin").next,
    );
    assert.deepEqual(asked[1]!.state, {
      brief: "Review the diff for bugs.",
      task: "Fix flaky retry test",
      agent_type: "general-purpose",
    });
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({
        prompt: "Check module 1.",
        workflow: { runId: "wf_req", agentIndex: 0 },
        tool_use_id: "",
      }),
      spawner("wf-0").next,
    );
    assert.equal(
      (asked[2]!.state as { from_workflow?: boolean }).from_workflow,
      true,
    );
    assert.equal(
      (asked[2]!.state as { parent_request?: string }).parent_request,
      undefined,
    );
    assert.equal(mainReads(), 0);
  });

  test("under request, after a reload, a thin brief still reads no transcript", async () => {
    const { hooks, $, asked, setMain, mainReads } = load(gw, {
      context: "request",
    });
    setMain(transcript("make the checkout flow handle expired cards"));
    await hooks.get("agent.spawn")!(
      $,
      spawnOf({ prompt: "Check module 0." }),
      spawner("thin-0").next,
    );
    assert.equal(
      (asked[0]!.state as { parent_request?: string }).parent_request,
      undefined,
    );
    assert.equal(mainReads(), 0);
  });

  test("/jev shows the setting, where it came from, and what it sends", async () => {
    const { hooks, $ } = load(gw, { context: "request" });
    const text = (await jev(hooks, $)).text;
    assert.match(text, /context\s+request \(option\) — sends only the request/);
    const env = load({ ...gw, JEV_ROUTER_CONTEXT: "request" });
    assert.match(
      (await jev(env.hooks, env.$)).text,
      /context\s+request \(env\)/,
    );
    const plain = load();
    assert.match(
      (await jev(plain.hooks, plain.$)).text,
      /context\s+full \(default\) — sends the request, recent chat/,
    );
  });
});
