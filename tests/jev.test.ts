import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ASK_INSTRUCTIONS,
  askJev,
  DEFAULT_TIMEOUT_MS,
  MAX_STATE_CHARS,
  requestBodyOf,
  subagentStateOf,
  timeoutOf,
  type HttpInitLike,
  type HttpResponseLike,
} from "../hooks/jev.ts";
import { DEFAULT_CONFIG } from "../hooks/config.ts";
import { labelOf, withLabel } from "../hooks/label.ts";
import {
  criteriaOf,
  decisionFor,
  DEFAULT_PAIR_CLAUSE,
  ladderOf,
  offeredPairs,
  offeredTiers,
  pairCriteriaOf,
  TIERS,
  type FableMode,
} from "../hooks/policy.ts";
import type { ProviderResult } from "../hooks/provider.ts";

const never = () => new Promise<never>(() => {});
const immediately = async () => undefined;

const answered = (body: unknown): HttpResponseLike => ({
  ok: true,
  status: 200,
  text: JSON.stringify(body),
});

const gatewayProvider: ProviderResult = {
  ok: true,
  name: "gateway",
  endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "gw-key",
};

const typeafeProvider: ProviderResult = {
  ok: true,
  name: "typesafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  apiKey: "ts-key",
};

const noKeyProvider: ProviderResult = {
  ok: false,
  reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
};

const base = {
  sleep: never,
  provider: gatewayProvider,
  state: "plan the migration",
  offered: TIERS,
};

describe("jev", () => {
  test("the request asks one question, the route, as a Choice", () => {
    const body = requestBodyOf("rename a variable", TIERS);
    assert.equal(body.state, "rename a variable");
    assert.deepEqual(Object.keys(body.questions), ["route"]);
    assert.equal(body.questions.route.type, "choice");
  });

  test("both asking kinds get the one question, each with its own wording, under every setting", () => {
    for (const asking of ["turn", "subagent"] as const) {
      for (const mode of ["never", "hardest", "open"] as FableMode[]) {
        const body = requestBodyOf("x", offeredTiers(new Set(), mode), asking, mode);
        assert.deepEqual(Object.keys(body.questions), ["route"]);
        assert.equal(body.questions.route.instructions, ASK_INSTRUCTIONS[asking]);
      }
    }
    assert.notEqual(ASK_INSTRUCTIONS.turn, ASK_INSTRUCTIONS.subagent);
  });

  test("the wording says what is chosen, a model and how hard it thinks, in one sentence", () => {
    for (const asking of ["turn", "subagent"] as const) {
      const line = ASK_INSTRUCTIONS[asking];
      assert.match(line, /which model, thinking how hard/i, asking);
      assert.equal(line.split(/[.?!](?:\s|$)/).filter((s) => s.trim()).length, 1, asking);
      assert.ok(line.endsWith("?"), asking);
    }
  });

  test("the wording never says where unclear work goes: the default pair says it, once", () => {
    for (const asking of ["turn", "subagent"] as const) {
      assert.doesNotMatch(ASK_INSTRUCTIONS[asking], /default|unclear|ordinary/i, asking);
      const body = JSON.stringify(requestBodyOf("x", TIERS, asking));
      assert.equal(body.split(DEFAULT_PAIR_CLAUSE).length - 1, 1, asking);
    }
  });

  test("a turn is asked as a request a developer typed, a subagent as a task done alone", () => {
    assert.match(ASK_INSTRUCTIONS.turn, /developer typed/);
    assert.match(ASK_INSTRUCTIONS.subagent, /subagent/);
    assert.match(ASK_INSTRUCTIONS.subagent, /alone/);
    assert.equal(requestBodyOf("x", TIERS).questions.route.instructions, ASK_INSTRUCTIONS.turn);
    assert.equal(
      requestBodyOf("x", TIERS, "subagent").questions.route.instructions,
      ASK_INSTRUCTIONS.subagent,
    );
    assert.deepEqual(
      requestBodyOf("x", TIERS, "subagent").questions.route.criteria,
      requestBodyOf("x", TIERS).questions.route.criteria,
      "the options mean the same thing either way",
    );
  });

  test("the options are the policy's pairs, in ladder order", () => {
    for (const mode of ["never", "hardest", "open"] as FableMode[]) {
      const offered = offeredTiers(new Set(), mode);
      const criteria = requestBodyOf("x", offered, "turn", mode).questions.route.criteria;
      assert.deepEqual(criteria, pairCriteriaOf(offered, mode), mode);
      assert.deepEqual(Object.keys(criteria), offeredPairs(offered), mode);
    }
  });

  test("the options are a fresh record, so a caller cannot edit the policy", () => {
    const body = requestBodyOf("x", TIERS);
    body.questions.route.criteria.opus_high = "anything";
    assert.notEqual(requestBodyOf("x", TIERS).questions.route.criteria.opus_high, "anything");
  });

  test("only the offered families' pairs reach Jev", () => {
    const keys = Object.keys(requestBodyOf("x", ["haiku", "opus"]).questions.route.criteria);
    assert.deepEqual(keys, [
      "haiku_medium",
      "haiku_high",
      "opus_medium",
      "opus_high",
      "opus_xhigh",
      "opus_max",
    ]);
  });

  test("Fable's pairs are offered under hardest and open, with the setting's line", () => {
    for (const mode of ["hardest", "open"] as FableMode[]) {
      const criteria = requestBodyOf("x", TIERS, "turn", mode).questions.route.criteria;
      assert.ok(criteria.fable_high?.startsWith(criteriaOf(mode).fable), mode);
    }
    assert.notEqual(
      requestBodyOf("x", TIERS, "turn", "open").questions.route.criteria.opus_high,
      requestBodyOf("x", TIERS, "turn", "hardest").questions.route.criteria.opus_high,
      "under open Opus means implementation, Fable the thinking",
    );
  });

  test("by default Fable is never among the options, even if a caller offers it", () => {
    for (const criteria of [
      requestBodyOf("x", TIERS).questions.route.criteria,
      requestBodyOf("x", TIERS, "subagent", "never").questions.route.criteria,
      requestBodyOf("x", offeredTiers(new Set())).questions.route.criteria,
    ]) {
      assert.equal(Object.keys(criteria).some((k) => /fable/i.test(k)), false);
      assert.equal(/fable/i.test(JSON.stringify(criteria)), false);
    }
    const body = JSON.stringify(requestBodyOf("use fable for this", TIERS));
    assert.ok(body.includes("use fable for this"), "the state is untouched");
  });

  test("the bands decide which pairs there are", () => {
    const ladder = ladderOf({ ...DEFAULT_CONFIG, opusEffort: "high-xhigh", haikuEffort: "medium" });
    const keys = Object.keys(requestBodyOf("x", TIERS, "turn", "never", ladder).questions.route.criteria);
    assert.deepEqual(keys, [
      "haiku_medium",
      "sonnet_medium",
      "sonnet_high",
      "sonnet_xhigh",
      "sonnet_max",
      "opus_high",
      "opus_xhigh",
    ]);
  });

  test("a state of named fields is sent as it is", () => {
    const state = { request: "rename foo", recent_turns: ["fix the test"] };
    assert.deepEqual(requestBodyOf(state, TIERS).state, state);
  });

  test("a state of named fields with nothing in it is not worth a round trip", async () => {
    let called = false;
    const got = await askJev({
      ...base,
      state: {},
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(called, false);
    assert.equal(got.ok, false);
  });

  test("askJev sends the wording it was asked for", async () => {
    const sent: { questions: Record<string, { instructions: string }> }[] = [];
    const capture = async (_url: string, init?: HttpInitLike) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return answered({ answers: {} });
    };
    await askJev({ ...base, fetch: capture });
    await askJev({ ...base, fetch: capture, asking: "subagent" });
    assert.equal(sent[0]?.questions.route?.instructions, ASK_INSTRUCTIONS.turn);
    assert.equal(sent[1]?.questions.route?.instructions, ASK_INSTRUCTIONS.subagent);
    assert.deepEqual(Object.keys(sent[1]?.questions ?? {}), ["route"]);
  });

  test("askJev asks with the Fable setting it was given, never by default", async () => {
    const sent: { questions: { route: { criteria: Record<string, string> } } }[] = [];
    const capture = async (_url: string, init?: HttpInitLike) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return answered({ answers: {} });
    };
    await askJev({ ...base, fetch: capture });
    await askJev({ ...base, fetch: capture, fable: "hardest" });
    await askJev({ ...base, fetch: capture, fable: "open" });
    const [never, hardest, open] = sent.map((b) => b.questions.route.criteria);
    assert.equal(Object.keys(never ?? {}).some((k) => k.startsWith("fable")), false);
    assert.equal(hardest?.fable_high, pairCriteriaOf(TIERS, "hardest").fable_high);
    assert.equal(open?.fable_high, pairCriteriaOf(TIERS, "open").fable_high);
    assert.equal(open?.opus_high, pairCriteriaOf(TIERS, "open").opus_high);
  });

  test("the provider's model rides along with the body", async () => {
    let body: { model?: string } = {};
    await askJev({
      ...base,
      provider: typeafeProvider,
      fetch: async (_url, init) => {
        body = JSON.parse(init?.body ?? "{}");
        return answered({ answers: {} });
      },
    });
    assert.equal(body.model, "jev-latest");
  });

  test("the gateway is never asked for a noul, which it refuses", () => {
    const types = Object.values(requestBodyOf("x", TIERS).questions).map(
      (q) => q.type,
    );
    for (const t of types)
      assert.ok(["choice", "score", "boolean"].includes(t));
  });

  test("a good answer comes back as the answers object", async () => {
    const answers = {
      route: {
        type: "choice",
        choice: "opus_high",
        confidence: 0.8,
        probabilities: { sonnet_high: 0.1, opus_high: 0.9 },
      },
    };
    const got = await askJev({
      ...base,
      fetch: async () => answered({ model: "jev-1.13.0", answers }),
    });
    assert.equal(got.ok, true);
    assert.deepEqual(got.ok && got.answers, answers);
  });

  test("it posts to the gateway with the key as a bearer token", async () => {
    let seen: { url?: string; init?: HttpInitLike } = {};
    await askJev({
      ...base,
      fetch: async (url, init) => {
        seen = { url, init };
        return answered({ answers: {} });
      },
    });
    assert.equal(seen.url, "https://ai-gateway.vercel.sh/v1/evaluate");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.headers?.authorization, "Bearer gw-key");
  });

  test("no key means no request at all", async () => {
    let called = false;
    const got = await askJev({
      ...base,
      provider: noKeyProvider,
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(got.ok, false);
    assert.equal(called, false);
    assert.match(
      got.ok === false ? got.reason : "",
      /no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY/,
    );
  });

  test("a slow gateway loses the race and the turn is left alone", async () => {
    const got = await askJev({
      ...base,
      fetch: never,
      sleep: immediately,
      timeoutMs: 1,
    });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /timed out/);
  });

  test("a failure is named, so the session can say why it went unrouted", async () => {
    const reasonOf = (r: Awaited<ReturnType<typeof askJev>>) =>
      r.ok === false ? r.reason : "UNEXPECTEDLY OK";

    const refused = await askJev({
      ...base,
      fetch: async () => ({
        ok: false,
        status: 403,
        text: JSON.stringify({
          error: { type: "customer_verification_required" },
        }),
      }),
    });
    assert.match(
      reasonOf(refused),
      /HTTP 403 \(customer_verification_required\)/,
    );

    const threw = await askJev({
      ...base,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.match(reasonOf(threw), /socket hang up/);

    const garbage = await askJev({
      ...base,
      fetch: async () => ({ ok: true, status: 200, text: "not json" }),
    });
    assert.match(reasonOf(garbage), /not JSON/);

    const empty = await askJev({
      ...base,
      fetch: async () => answered({ model: "jev" }),
    });
    assert.match(reasonOf(empty), /no answers/);
  });

  test("an empty prompt is not worth a round trip", async () => {
    let called = false;
    await askJev({
      ...base,
      state: "   ",
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(called, false);
  });

  test("a call is timed, so the status report can show how slow Jev was", async () => {
    let t = 1000;
    const got = await askJev({
      ...base,
      now: () => t,
      fetch: async () => {
        t += 640;
        return answered({
          answers: { route: { type: "choice", choice: "opus_high" } },
        });
      },
    });
    assert.equal(got.ms, 640);
  });
});

describe("subagent state", () => {
  test("the header names the agent, its task, and a workflow sender", () => {
    const state = subagentStateOf({
      prompt: "Fix the flaky retry test in tests/net.test.ts.",
      description: "Fix flaky retry test",
      subagentType: "general-purpose",
      workflow: true,
    });
    assert.equal(
      state,
      "Subagent type: general-purpose\n" +
        "Task: Fix flaky retry test\n" +
        "From a workflow script: yes\n\n" +
        "Fix the flaky retry test in tests/net.test.ts.",
    );
  });

  test("a header line with nothing to say is left out", () => {
    assert.equal(
      subagentStateOf({ prompt: "List the files.", workflow: false }),
      "List the files.",
    );
    assert.equal(
      subagentStateOf({
        prompt: "List the files.",
        description: "  ",
        subagentType: "Explore",
      }),
      "Subagent type: Explore\n\nList the files.",
    );
  });

  test("a short brief is sent whole", () => {
    const prompt = "x".repeat(MAX_STATE_CHARS - 100);
    const state = subagentStateOf({ prompt, subagentType: "Plan" });
    assert.ok(state.endsWith(prompt));
    assert.equal(state.includes("elided"), false);
  });

  test("a long brief keeps its head and tail and says what it dropped", () => {
    const head = "TASK: audit the payment module for races.\n";
    const tail = "\nReturn JSON: {findings: [...]}. Do not commit.";
    const prompt = head + "filler line\n".repeat(5000) + tail;
    const state = subagentStateOf({
      prompt,
      description: "Audit payments",
      subagentType: "general-purpose",
      workflow: true,
    });
    assert.ok(state.length <= MAX_STATE_CHARS, `${state.length} chars`);
    assert.ok(state.length > MAX_STATE_CHARS - 50, "the budget is used");
    assert.ok(state.startsWith("Subagent type: general-purpose\n"));
    assert.ok(state.includes(head), "the head survives");
    assert.ok(state.endsWith(tail.trim()), "the tail survives");

    const marker = /\[… (\d+) chars elided …\]/.exec(state);
    assert.ok(marker, "the cut is marked");
    const kept = state.length - marker[0].length;
    const header = state.indexOf("\n\n") + 2;
    assert.equal(
      Number(marker[1]),
      prompt.trim().length - (kept - header - 2),
      "the count is what went missing",
    );
  });

  test("a brief with no header still fits", () => {
    const state = subagentStateOf({ prompt: "a".repeat(50_000) + "END" });
    assert.ok(state.length <= MAX_STATE_CHARS);
    assert.ok(state.startsWith("aaa"));
    assert.ok(state.endsWith("END"));
  });

  test("a runaway description cannot crowd out the brief", () => {
    const state = subagentStateOf({
      prompt: "Rename foo to bar in utils.ts.",
      description: "d".repeat(20_000),
    });
    assert.ok(state.length < 1000);
    assert.ok(state.endsWith("Rename foo to bar in utils.ts."));
  });
});

describe("label", () => {
  const decision = decisionFor("opus", 0.9);

  test("a confident pick reads as family and effort", () => {
    assert.equal(labelOf(decision, true), "jev → opus·high");
    assert.equal(
      labelOf(decisionFor("sonnet", 0.9, "medium"), true),
      "jev → sonnet·medium",
    );
    assert.equal(
      labelOf(decisionFor("sonnet", 0.9, "xhigh"), true),
      "jev → sonnet·xhigh",
    );
    assert.equal(
      labelOf(decisionFor("opus", 0.9, "max"), true),
      "jev → opus·max",
    );
    assert.equal(
      labelOf(decisionFor("haiku", 0.9, "low"), true),
      "jev → haiku·medium",
      "Haiku never runs at low",
    );
  });

  test("an unconfident pick is marked", () => {
    assert.equal(
      labelOf({ ...decision, confidence: 0.2 }, true),
      "jev → opus·high?",
    );
  });

  test("routing off says so, and before the first turn nothing is added", () => {
    assert.equal(labelOf(decision, false), "jev off");
    assert.equal(labelOf(null, true), null);
  });

  test("the label joins the engine’s own modes without duplicating", () => {
    assert.deepEqual(withLabel(["plan mode"], "jev off"), [
      "plan mode",
      "jev off",
    ]);
    assert.deepEqual(withLabel(["jev off"], "jev off"), ["jev off"]);
    assert.deepEqual(withLabel(["plan mode"], null), ["plan mode"]);
  });
});

describe("timeout", () => {
  test("an unset, empty or nonsense budget falls back to the default", () => {
    assert.equal(timeoutOf(undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf(""), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("soon"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("0"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("-5"), DEFAULT_TIMEOUT_MS);
  });

  test("a budget from the environment is used", () => {
    assert.equal(timeoutOf("2500"), 2500);
  });

  test("the default clears the slowest live call measured (839ms)", () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 839);
  });
});

describe("the options follow the ladder's default", () => {
  test("requestBodyOf names the configured default pair as the catch-all, and no other", () => {
    const ladder = ladderOf({ ...DEFAULT_CONFIG, defaultModel: "sonnet" });
    const criteria = requestBodyOf("x", TIERS, "subagent", "never", ladder)
      .questions.route.criteria;
    assert.deepEqual(criteria, pairCriteriaOf(TIERS, "never", ladder));
    const carrying = Object.entries(criteria)
      .filter(([, line]) => line?.includes(DEFAULT_PAIR_CLAUSE))
      .map(([pair]) => pair);
    assert.deepEqual(carrying, ["sonnet_high"]);
  });

  test("askJev sends the ladder's options", async () => {
    const bodies: {
      questions: { route: { criteria: Record<string, string> } };
    }[] = [];
    const ladder = ladderOf({ ...DEFAULT_CONFIG, defaultModel: "haiku" });
    await askJev({
      ...base,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return answered({ answers: {} });
      },
      ladder,
    });
    assert.deepEqual(
      bodies[0]?.questions.route.criteria,
      pairCriteriaOf(TIERS, "never", ladder),
    );
    assert.match(bodies[0]?.questions.route.criteria.haiku_high ?? "", /does not clearly fit/);
  });
});
