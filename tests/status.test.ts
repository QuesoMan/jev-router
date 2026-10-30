import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  announceReply,
  attemptOf,
  stickyCommand,
  liveLine,
  NO_OFFERED_TIER,
  REPLY_SEPARATOR,
  routedDecisionOf,
  spawnAttemptOf,
  statusReport,
  toggleReply,
  type Status,
  addUsage,
  cacheRatio,
  configSourcesOf,
  routeOf,
  continuedAttemptOf,
  unroutedAttemptOf,
  unroutedSpawnOf,
  usageFooter,
  type Attempt,
  type Usage,
} from "../hooks/status.ts";
import { DEFAULT_CONFIG } from "../hooks/config.ts";
import { labelOf, marksOf, rungOf } from "../hooks/label.ts";
import {
  clampEffort,
  decisionFor,
  DEFAULT_LADDER,
  DEFAULT_STICKY_CONFIDENCE,
  EFFORTS,
  fallbackDecision,
  isTier,
  offeredTiers,
  type Effort,
  type Ladder,
} from "../hooks/policy.ts";
import type { ProviderResult } from "../hooks/provider.ts";
import {
  concentrationOf,
  sharesFor,
  topOf,
} from "./jev-answers.ts";

/** The ladder offered under the default setting: Fable left off. */
const TIERS = offeredTiers(new Set());
/** The whole ladder, Fable included, as "hardest" and "open" offer it. */
const ALL = offeredTiers(new Set(), "open");

const decision = decisionFor("opus", 0.97, "max");

const goodProvider: ProviderResult = {
  ok: true,
  name: "gateway",
  endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "test-key",
};

const noKeyProvider: ProviderResult = {
  ok: false,
  reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
};

const base: Status = {
  enabled: true,
  surface: "desktop",
  provider: goodProvider,
  timeoutMs: 1500,
  sticky: null,
  config: DEFAULT_CONFIG,
  offered: TIERS,
  excluded: [],
  announce: true,
  attempts: [],
};

/**
 * Jev's `route` answer as the live API sends it, from a distribution over
 * families and an effort (0 low to 4 max): each family's share on its pair
 * at that effort, held to the family's band on `ladder` (the default one
 * unless a test says), which is what the request would have offered. No effort is the default
 * effort, held the same way. A name that is not a family is sent as it is.
 */
function routeAnswerOf(
  shares: Record<string, number>,
  effort?: number,
  ladder: Ladder = DEFAULT_LADDER,
) {
  const wanted: Effort =
    effort !== undefined ? EFFORTS[Math.round(effort)]! : ladder.defaultEffort;
  const probabilities: Record<string, number> = {};
  for (const [name, p] of Object.entries(shares)) {
    const pair = isTier(name)
      ? `${name}_${clampEffort(name, wanted, ladder)}`
      : name;
    probabilities[pair] = (probabilities[pair] ?? 0) + p;
  }
  return {
    type: "choice",
    choice: topOf(probabilities),
    confidence: concentrationOf(probabilities, 10),
    probabilities,
  };
}

/**
 * Jev's answer to the request: a family with `share` of Jev's probability
 * on it (the rest where `sharesFor` puts Jev's doubt), and an effort when
 * the test cares which.
 */
const answer = (
  choice: string,
  share = 0.9,
  effort?: number,
  ladder?: Ladder,
) => ({
  ok: true as const,
  ms: 500,
  answers: { route: routeAnswerOf(sharesFor(choice, share), effort, ladder) },
});

/** The same, from a whole distribution over the families. */
const answerOf = (shares: Record<string, number>, effort?: number) => ({
  ok: true as const,
  ms: 500,
  answers: { route: routeAnswerOf(shares, effort) },
});

/**
 * Top choice Haiku at 40%, but only 40% says Haiku is enough: at the
 * default floor the pick moves up to Sonnet, the median, marked floored.
 */
const SPLIT = { haiku: 0.4, sonnet: 0.25, opus: 0.35 };

describe("status report", () => {
  test('the first lines answer "is this even on"', () => {
    const lines = statusReport(base).split("\n");
    assert.match(lines[1] ?? "", /routing\s+on/);
    assert.match(lines[2] ?? "", /surface\s+desktop/);
    assert.match(lines[3] ?? "", /gateway.*AI_GATEWAY_API_KEY is set/);
  });

  test("a missing key is stated loudly: routing is off, and how to set one", () => {
    const text = statusReport({ ...base, provider: noKeyProvider });
    const lines = text.split("\n");
    assert.match(lines[1] ?? "", /routing\s+off — no Jev key is set/);
    assert.match(text, /NO KEY — no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY/);
    assert.match(text, /set TYPESAFE_API_KEY \(or AI_GATEWAY_API_KEY\)/);
    assert.match(text, /settings\.json/);
    assert.match(text, /blocked\s+nothing, routing is off/);
    for (const line of lines) assert.ok(line.length < 100, line);
  });

  test("off is off: with /jev off nothing is blocked either", () => {
    const text = statusReport({ ...base, enabled: false });
    assert.match(text, /blocked\s+nothing, routing is off/);
  });

  test("a continuation is tagged as one, on the rung it carried on", () => {
    const a = continuedAttemptOf(decision);
    assert.match(liveLine(a), /^> ✳️ `opus·max` · 97% · continue · 0ms$/);
  });

  test("routing off says how to turn it back on", () => {
    assert.match(statusReport({ ...base, enabled: false }), /off \(\/jev on\)/);
  });

  test("before any turn it says so rather than showing an empty table", () => {
    assert.match(statusReport(base), /No turns yet/);
  });

  test("the ladder lists each family with its model and effort range, the default marked", () => {
    const text = statusReport(base);
    assert.match(text, /ladder\s+haiku\s+claude-haiku-5-5\s+medium–high$/m);
    assert.match(text, /^\s+sonnet\s+claude-sonnet-5-5\s+medium–max$/m);
    assert.match(
      text,
      /^\s+opus\s+claude-opus-5-5\s+medium–max {2}\(default: high\)$/m,
    );
    assert.doesNotMatch(text, /sonnet.*\(default/);
    assert.doesNotMatch(text, /opus-high|sonnet-medium|haiku.*low/);
  });

  test("the ladder's ranges come from EFFORT_RANGE, one line per offered family", () => {
    const lines = statusReport({ ...base, offered: ALL })
      .split("\n")
      .filter((l) => /claude-(haiku|sonnet|opus|fable)-/.test(l));
    assert.deepEqual(
      lines.map((l) => l.trim().split(/\s+/).slice(0, 3)),
      [
        ["ladder", "haiku", "claude-haiku-5-5"],
        ["sonnet", "claude-sonnet-5-5", "medium–max"],
        ["opus", "claude-opus-5-5", "medium–max"],
        ["fable", "claude-fable-5-1", "medium–max"],
      ],
    );
  });

  test("the default gets a line of its own, saying what it is for", () => {
    assert.match(
      statusReport(base),
      /^ {2}default {3}opus·high, for fallbacks and anything unclear$/m,
    );
  });

  test("the bands and the default are the settings', not the constants", () => {
    const text = statusReport({
      ...base,
      config: {
        ...DEFAULT_CONFIG,
        defaultModel: "sonnet",
        defaultEffort: "xhigh",
        haikuEffort: "high",
        opusEffort: "high-max",
      },
    });
    assert.match(text, /default\s+sonnet·xhigh/);
    assert.match(text, /ladder\s+haiku\s+claude-haiku-5-5\s+high$/m);
    assert.match(
      text,
      /^\s+sonnet\s+claude-sonnet-5-5\s+medium–max {2}\(default: xhigh\)$/m,
    );
    assert.match(text, /^\s+opus\s+claude-opus-5-5\s+high–max$/m);
    // The floor reads Jev's distribution, so the default does not move it.
    assert.match(text, /floor\s+a pick needs 50% of Jev's probability on its model or cheaper/);
  });

  test("each band and each half of the default say where they came from", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, opusEffort: "high", defaultModel: "opus" },
      sources: {
        ...configSourcesOf(undefined, {}),
        opusEffort: "env",
        defaultModel: "option",
      },
    });
    assert.match(
      text,
      /default\s+opus·high — model \(option\), effort \(default\), for fallbacks/,
    );
    assert.match(text, /^\s+opus\s+claude-opus-5-5\s+high \(env\) {2}\(default: high\)$/m);
    assert.match(text, /^\s+sonnet\s+claude-sonnet-5-5\s+medium–max$/m, "unset says nothing");
    assert.match(text, /fable\s+never \(default\) — opus·high is the ceiling/);
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("a default of Fable the setting refuses is reported, with Opus standing in", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, fable: "hardest", defaultModel: "fable" },
      offered: offeredTiers(new Set(), "hardest"),
    });
    assert.match(text, /default\s+opus·high/);
    assert.match(text, /fable can't be the default under hardest, so opus/);
    assert.match(text, /^\s+opus\s+claude-opus-5-5\s+medium–max {2}\(default: high\)$/m);
    assert.doesNotMatch(text, /fable\s+claude-fable-5-1.*\(default/);
  });

  test("a default effort outside the default's band is reported as clamped", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, defaultModel: "haiku", defaultEffort: "low" },
    });
    assert.match(text, /default\s+haiku·medium/);
    assert.match(text, /low is outside haiku's band \(medium–high\), so medium/);
    assert.match(text, /floor\s+a pick needs 50%/);
  });

  test("a config from before the ladder was a setting reports the default ladder", () => {
    const { fable, fableConfidence, minConfidence, routeSubagents } =
      DEFAULT_CONFIG;
    const text = statusReport({
      ...base,
      config: { fable, fableConfidence, minConfidence, routeSubagents },
    });
    assert.match(text, /default\s+opus·high/);
    assert.match(text, /^\s+opus\s+claude-opus-5-5\s+medium–max {2}\(default: high\)$/m);
  });

  test("a blocked request's line names where it went: the default, lifted to Opus", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, defaultModel: "sonnet", defaultEffort: "medium" },
      attempts: [
        {
          ...unroutedSpawnOf({ prompt: "x", description: "fork" }, "fork"),
          blocked: "claude-fable-5-1",
        },
      ],
    });
    assert.match(text, /blocked claude-fable-5-1 → opus·medium/);
  });

  test("Fable is said to be blocked, and appears nowhere on the ladder", () => {
    const text = statusReport(base);
    assert.match(text, /blocked\s+fable/);
    assert.doesNotMatch(text, /claude-fable/);
  });

  test("the confidence floor is reported, and so is turning it off", () => {
    assert.match(
      statusReport(base),
      /floor\s+a pick needs 50% of Jev's probability on its model or cheaper$/m,
    );
    assert.match(
      statusReport({
        ...base,
        config: { ...DEFAULT_CONFIG, minConfidence: 0 },
      }),
      /floor\s+off — Jev's top choice/,
    );
  });

  test("the Fable setting is reported, with Opus at max as the ceiling by default", () => {
    assert.match(statusReport(base), /fable\s+never — opus·max is the ceiling/);
  });

  test("under hardest the report gives the bar and offers Fable on the ladder", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, fable: "hardest", fableConfidence: 0.8 },
      offered: offeredTiers(new Set(), "hardest"),
    });
    assert.match(text, /fable\s+hardest — a pick needs 80% on fable, else opus·max/);
    assert.match(text, /fable\s+claude-fable-5-1\s+medium–max/);
    assert.match(text, /blocked\s+fable, unless Jev itself picks it/);
  });

  test("under open nothing is blocked", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, fable: "open" },
      offered: ALL,
    });
    assert.match(text, /fable\s+open — an ordinary family/);
    assert.match(text, /blocked\s+nothing/);
  });

  test("subagent routing off is reported", () => {
    assert.match(statusReport(base), /agents\s+each new subagent/);
    assert.match(
      statusReport({
        ...base,
        config: { ...DEFAULT_CONFIG, routeSubagents: false },
      }),
      /agents\s+not routed/,
    );
  });

  test("the context setting, where it came from, and what it sends, in one line", () => {
    const full = statusReport({
      ...base,
      sources: { ...configSourcesOf(undefined, {}) },
    });
    const fullLine = full.split("\n").find((l) => /^\s+context\s/.test(l));
    assert.ok(fullLine !== undefined, full);
    assert.match(fullLine, /context\s+full \(default\) — sends the request, recent chat/);
    assert.match(fullLine, /tool output/);

    const narrow = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, context: "request" },
      sources: configSourcesOf(undefined, { JEV_ROUTER_CONTEXT: "request" }),
    });
    const lines = narrow.split("\n").filter((l) => /^\s+context\s/.test(l));
    assert.equal(lines.length, 1, "one line");
    assert.match(lines[0]!, /context\s+request \(env\) — sends only the request/);
    assert.match(lines[0]!, /no transcript/);
    for (const line of [fullLine, lines[0]!]) assert.ok(line.length < 100, line);
  });

  test("a config without the context setting reads as full", () => {
    const { fable, fableConfidence, minConfidence, routeSubagents } =
      DEFAULT_CONFIG;
    const text = statusReport({
      ...base,
      config: { fable, fableConfidence, minConfidence, routeSubagents },
    });
    assert.match(text, /context\s+full — /);
  });

  test("where each setting came from is printed beside it, when known", () => {
    const text = statusReport({
      ...base,
      config: { ...DEFAULT_CONFIG, fable: "hardest", minConfidence: 0.2 },
      sources: {
        fable: "env",
        fableConfidence: "default",
        minConfidence: "option",
        routeSubagents: "default",
      },
    });
    assert.match(
      text,
      /fable\s+hardest \(env\) — a pick needs 75% \(default\)/,
    );
    assert.match(text, /floor\s+a pick needs 20% \(option\) of Jev's probability/);
    assert.match(text, /agents\s+each new subagent.*\(default\)/);
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("a routed turn shows its rung, confidence and latency", () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: "plan the migration", ms: 641, decision }],
    });
    assert.match(text, /641ms/);
    assert.match(text, /opus·max 0\.97/);
    assert.match(text, /plan the migration/);
  });

  test("a fallback turn shows the default it ran on and why", () => {
    const text = statusReport({
      ...base,
      attempts: [
        {
          prompt: "x",
          ms: 12,
          decision: fallbackDecision(
            "gateway said HTTP 403 (customer_verification_required)",
          ),
        },
      ],
    });
    assert.match(text, /opus·high fallback — gateway said HTTP 403/);
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("a pick under half is called out in words, not a symbol", () => {
    const text = statusReport({
      ...base,
      attempts: [
        { prompt: "x", ms: 400, decision: { ...decision, confidence: 0.3 } },
      ],
    });
    assert.match(text, /(under half)/);
  });

  test("excluded tiers are listed only when there are some, and leave the ladder", () => {
    assert.doesNotMatch(statusReport(base), /excluded/);
    const text = statusReport({
      ...base,
      excluded: ["haiku"],
      offered: ["sonnet", "opus"],
    });
    assert.match(text, /excluded\s+haiku/);
    assert.match(text, /ladder\s+sonnet\s+claude-sonnet-5-5/);
    assert.doesNotMatch(text, /claude-haiku/);
  });

  test("a long prompt is trimmed so the report stays one screen", () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: "a".repeat(200), ms: 1, decision }],
    });
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("toggling reports the state it moved to", () => {
    assert.match(toggleReply(true), /on\./);
    assert.match(toggleReply(false), /exactly as it came, Fable included/);
    assert.match(
      toggleReply(true, noKeyProvider),
      /nothing is routed yet: no TYPESAFE_API_KEY.*Set TYPESAFE_API_KEY/,
    );
  });
});

describe("live line", () => {
  test("a routed turn is announced with family·effort, confidence and latency", () => {
    assert.equal(
      liveLine({ prompt: "plan the migration", ms: 641, decision }),
      "> ✳️ `opus·max` · 97% · 641ms",
    );
  });

  test("the cheaper families read as family and effort, the effort clamped", () => {
    const line = (tier: "haiku" | "sonnet", effort?: Effort) =>
      liveLine({ prompt: "x", ms: 1, decision: decisionFor(tier, 0.9, effort) });
    assert.match(line("haiku", "low"), /`haiku·medium`/);
    assert.match(line("haiku", "max"), /`haiku·high`/);
    assert.match(line("sonnet", "medium"), /`sonnet·medium`/);
    assert.match(line("sonnet", "xhigh"), /`sonnet·xhigh`/);
    assert.match(line("sonnet"), /`sonnet·high`/);
  });

  test("a fallback still announces why, rather than going silent", () => {
    assert.equal(
      liveLine({
        prompt: "x",
        ms: 0,
        decision: fallbackDecision("no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY"),
      }),
      "> ⚠️ `opus·high` · fallback — no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
    );
  });

  test("a subagent nobody routed still reads as unrouted", () => {
    assert.equal(
      liveLine({
        prompt: "x",
        ms: 0,
        skipped: "fork keeps its parent's model",
      }),
      "> ⚠️ `unrouted` · fork keeps its parent's model",
    );
  });

  test("a shaky pick is marked so a bad route is visible as it happens", () => {
    assert.match(
      liveLine({
        prompt: "x",
        ms: 400,
        decision: { ...decision, confidence: 0.3 },
      }),
      /· 30%\? ·/,
    );
  });

  test("a floored pick says what Jev wanted, and is not marked twice", () => {
    const line = liveLine({
      prompt: "x",
      ms: 400,
      decision: { ...decisionFor("opus", 0.3), floored: "haiku" },
    });
    assert.equal(line, "> ✳️ `opus·high` · 30% · floored:haiku · 400ms");
  });

  test("the line is a blockquote with the rung as inline code, since that is what the transcript can colour", () => {
    const line = liveLine({ prompt: "x", ms: 641, decision });
    assert.ok(line.startsWith("> "), line);
    assert.match(line, /`opus·max`/);
  });

  test("the separator is a rule with a blank line before it, or --- would make the route a heading", () => {
    assert.equal(REPLY_SEPARATOR, "\n\n---\n\n");
  });

  test("the line stays short enough not to wrap", () => {
    const line = liveLine({ prompt: "a".repeat(300), ms: 641, decision });
    assert.ok(line.length < 60, line);
  });

  test("announcing can be turned off without turning routing off", () => {
    assert.match(announceReply(false), /quietly/);
    assert.match(announceReply(true), /announce/);
    assert.match(statusReport({ ...base, announce: false }), /announce\s+off/);
  });
});

describe("attemptOf", () => {
  test("a good answer becomes a routed attempt", () => {
    const attempt = attemptOf("plan it", answer("opus", 0.9, 4), TIERS);
    assert.equal(attempt.decision.tier, "opus");
    assert.equal(attempt.decision.model, "claude-opus-5-5");
    assert.equal(attempt.decision.effort, "max");
    assert.equal(attempt.ms, 500);
  });

  test("a failed call falls back to the default and keeps its reason", () => {
    const attempt = attemptOf(
      "x",
      { ok: false, ms: 9, reason: "timed out after 1500ms" },
      TIERS,
    );
    assert.equal(attempt.decision.tier, "opus");
    assert.equal(attempt.decision.model, "claude-opus-5-5");
    assert.equal(attempt.decision.effort, "high");
    assert.equal(attempt.decision.fallback, "timed out after 1500ms");
    assert.equal(attempt.ms, 9);
  });

  test("an answer naming a tier we did not offer falls back with its own reason", () => {
    const attempt = attemptOf(
      "x",
      { ok: true, ms: 5, answers: { tier: {} } },
      TIERS,
    );
    assert.equal(attempt.decision.tier, "opus");
    assert.equal(attempt.decision.fallback, NO_OFFERED_TIER);
  });

  test("a tier name we did not offer falls back, an old rung name included", () => {
    const old = attemptOf("x", answer("opus-high", 0.99), TIERS);
    assert.equal(old.decision.tier, "opus");
    assert.equal(old.decision.fallback, NO_OFFERED_TIER);
    const attempt = attemptOf("x", answerOf({ fable: 1 }), TIERS);
    assert.equal(attempt.decision.tier, "opus");
    assert.ok(attempt.decision.fallback);
  });

  test("probability on a tier not offered is dropped, and the rest still routes", () => {
    const attempt = attemptOf("x", answerOf({ sonnet: 0.3, fable: 0.7 }), TIERS);
    assert.equal(attempt.decision.tier, "sonnet");
    assert.equal(attempt.decision.fallback, undefined);
    assert.equal(attempt.decision.confidence, 1);
  });

  test("under hardest a shaky Fable pick is capped to Opus at max, and says so", () => {
    const attempt = attemptOf("x", answer("fable", 0.6, 2), ALL, {
      fable: "hardest",
      fableConfidence: 0.75,
    });
    assert.equal(attempt.decision.tier, "opus");
    assert.equal(attempt.decision.effort, "max");
    assert.equal(attempt.decision.capped, "fable");
    // The number is the share behind what runs: 40% says Opus will do.
    assert.match(liveLine(attempt), /`opus·max` · 40% · capped:fable ·/);
  });

  test("under hardest a confident Fable pick runs on Fable", () => {
    const attempt = attemptOf("x", answer("fable", 0.9), ALL, {
      fable: "hardest",
      fableConfidence: 0.75,
    });
    assert.equal(attempt.decision.model, "claude-fable-5-1");
    assert.match(liveLine(attempt), /`fable·high` · 100%/);
  });

  test("under never a Fable pick is capped even if a caller offers it", () => {
    const attempt = attemptOf("x", answer("fable", 0.99), ALL);
    assert.equal(attempt.decision.tier, "opus");
    assert.equal(attempt.decision.capped, "fable");
  });

  test("routeOf carries the settings into the route, the ladder included", () => {
    assert.deepEqual(
      routeOf({ ...DEFAULT_CONFIG, fable: "open", minConfidence: 0.3 }),
      {
        floor: 0.3,
        fable: "open",
        fableConfidence: 0.75,
        ladder: DEFAULT_LADDER,
      },
    );
    const route = routeOf({
      ...DEFAULT_CONFIG,
      defaultModel: "sonnet",
      opusEffort: "high",
    });
    assert.equal(route.ladder?.defaultTier, "sonnet");
    assert.deepEqual(route.ladder?.bands.opus, { min: "high", max: "high" });
  });

  test("routeOf on a config without the ladder's fields is the default ladder", () => {
    const { fable, fableConfidence, minConfidence, routeSubagents } =
      DEFAULT_CONFIG;
    assert.deepEqual(
      routeOf({ fable, fableConfidence, minConfidence, routeSubagents }).ladder,
      DEFAULT_LADDER,
    );
  });

  test("a failed call falls back to the route's default model and effort", () => {
    const route = routeOf({
      ...DEFAULT_CONFIG,
      defaultModel: "sonnet",
      defaultEffort: "medium",
    });
    const d = attemptOf("x", { ok: false, ms: 3, reason: "down" }, TIERS, route)
      .decision;
    assert.deepEqual(
      { tier: d.tier, effort: d.effort, fallback: d.fallback },
      { tier: "sonnet", effort: "medium", fallback: "down" },
    );
    const none = attemptOf("x", answer("opus-high"), TIERS, route).decision;
    assert.equal(none.tier, "sonnet");
    assert.equal(none.fallback, NO_OFFERED_TIER);
  });

  test("the floor reads Jev's distribution, whatever the route's default", () => {
    for (const defaultModel of ["haiku", "sonnet", "opus"]) {
      const route = routeOf({ ...DEFAULT_CONFIG, defaultModel });
      const split = attemptOf("x", answerOf(SPLIT, 2), TIERS, route).decision;
      assert.equal(split.tier, "sonnet", defaultModel);
      assert.equal(split.effort, "high", defaultModel);
      assert.equal(split.floored, "haiku", defaultModel);
      const doubt = attemptOf("x", answer("haiku", 0.3, 2), TIERS, route).decision;
      assert.equal(doubt.tier, "opus", `${defaultModel}: 70% on Opus`);
      assert.equal(doubt.floored, undefined, defaultModel);
    }
  });

  test("a narrowed band clamps Jev's effort, and the Fable cap lands on its top", () => {
    const route = routeOf({
      ...DEFAULT_CONFIG,
      fable: "hardest",
      opusEffort: "medium-xhigh",
    });
    assert.equal(
      attemptOf("x", answer("opus", 0.9, 4, route.ladder), ALL, route).decision
        .effort,
      "xhigh",
    );
    const capped = attemptOf(
      "x",
      answer("fable", 0.6, 4, route.ladder),
      ALL,
      route,
    ).decision;
    assert.deepEqual(
      { tier: capped.tier, effort: capped.effort, capped: capped.capped },
      { tier: "opus", effort: "xhigh", capped: "fable" },
    );
  });

  test("a held turn's effort is clamped into the held model's band on the route's ladder", () => {
    const route = {
      ...routeOf({ ...DEFAULT_CONFIG, opusEffort: "medium-high" }),
      sticky: 0.75,
      running: decisionFor("opus", 0.9),
    };
    const held = attemptOf(
      "x",
      answer("sonnet", 0.6, 4, route.ladder),
      TIERS,
      route,
    ).decision;
    assert.deepEqual(
      { tier: held.tier, effort: held.effort, held: held.held },
      { tier: "opus", effort: "high", held: "sonnet" },
    );
  });

  test("a pick the floor moves above Jev's top choice is marked floored", () => {
    const attempt = attemptOf("x", answer("haiku", 0.55), TIERS, { floor: 0.6 });
    assert.equal(attempt.decision.tier, "opus");
    assert.equal(attempt.decision.floored, "haiku");
    const off = attemptOf("x", answer("haiku", 0.55), TIERS, { floor: 0 });
    assert.equal(off.decision.tier, "haiku", "0 is Jev's top choice");
    assert.equal(off.decision.floored, undefined);
  });

  test("a confident cheap pick is taken", () => {
    const attempt = attemptOf("x", answer("sonnet", 0.8, 1), TIERS);
    assert.equal(attempt.decision.model, "claude-sonnet-5-5");
    assert.equal(attempt.decision.effort, "medium");
  });

  test("stickiness applies after the floor, to what would actually run", () => {
    const running = decisionFor("opus", 0.9);
    const attempt = attemptOf("x", answer("sonnet", 0.6), TIERS, {
      sticky: 0.75,
      running,
      floor: 0.5,
    });
    assert.equal(attempt.decision.model, "claude-opus-5-5");
    assert.equal(attempt.decision.held, "sonnet");
  });

  test("routedDecisionOf without a route is the floor at its default", () => {
    assert.equal(routedDecisionOf(answerOf(SPLIT), TIERS).floored, "haiku");
    assert.equal(routedDecisionOf(answer("haiku", 0.49), TIERS).tier, "opus");
    assert.equal(routedDecisionOf(answer("haiku", 0.5), TIERS).tier, "haiku");
  });
});

describe("spawnAttemptOf", () => {
  test("a subagent's row names its type and task, and what it was routed to", () => {
    const a = spawnAttemptOf(
      {
        prompt: "Fix the flaky retry test.",
        description: "Fix flaky test",
        subagentType: "general-purpose",
      },
      answer("sonnet", 0.8),
      TIERS,
    );
    assert.equal(a.kind, "agent");
    assert.deepEqual(a.agent, {
      type: "general-purpose",
      label: "Fix flaky test",
    });
    assert.equal(a.prompt, "Fix flaky test");
    assert.equal(a.decision.tier, "sonnet");
    assert.equal(a.asked, undefined);
  });

  test("a workflow agent is marked as one, and the model it asked for is kept", () => {
    const a = spawnAttemptOf(
      { prompt: "Review it.", workflow: true, model: "claude-fable-5-1" },
      answer("opus", 0.9, 4),
      TIERS,
    );
    assert.equal(a.kind, "workflow");
    assert.equal(a.asked, "claude-fable-5-1");
    assert.equal(a.decision.model, "claude-opus-5-5");
  });

  test("a failed call falls back to the default, like the main loop", () => {
    const a = spawnAttemptOf(
      { prompt: "x" },
      { ok: false, ms: 3, reason: "timed out after 1500ms" },
      TIERS,
    );
    assert.equal(a.decision.tier, "opus");
    assert.equal(a.decision.fallback, "timed out after 1500ms");
  });

  test("the floor applies to subagents too", () => {
    const a = spawnAttemptOf({ prompt: "x" }, answerOf(SPLIT), TIERS, {
      floor: 0.5,
    });
    assert.equal(a.decision.tier, "sonnet");
    assert.equal(a.decision.floored, "haiku");
  });

  test("the Fable gate applies to subagents, and stickiness never does", () => {
    const a = spawnAttemptOf({ prompt: "x" }, answer("fable", 0.6), ALL, {
      fable: "hardest",
      fableConfidence: 0.75,
      sticky: 0.75,
      running: decisionFor("opus", 0.9),
    });
    assert.equal(a.decision.capped, "fable");
    assert.equal(a.decision.held, undefined);
  });

  test("a subagent left unrouted keeps its name and what its caller asked for", () => {
    const a = unroutedSpawnOf(
      {
        prompt: "Review it.",
        description: "Review the diff",
        subagentType: "reviewer",
        model: "claude-sonnet-5-5",
      },
      "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
    );
    assert.ok("skipped" in a);
    assert.equal(a.kind, "agent");
    assert.equal(a.asked, "claude-sonnet-5-5");
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /unrouted — \[agent:reviewer\] Review the diff/,
    );
  });

  test("a main-loop turn left unrouted says why, a notification still tagged", () => {
    const a = unroutedAttemptOf("plan it", "no keys");
    assert.equal(liveLine(a), "> ⚠️ `unrouted` · no keys");
    const n = unroutedAttemptOf(
      "<task-notification><summary>done</summary></task-notification>",
      "no keys",
    );
    assert.equal(n.kind, "notify");
    assert.equal(n.prompt, "done");
  });

  test("the report shows what a subagent asked for and where it went", () => {
    const a = spawnAttemptOf(
      {
        prompt: "Review it.",
        description: "Review the diff",
        subagentType: "reviewer",
        workflow: true,
        model: "claude-fable-5-1",
      },
      answer("opus", 0.9, 4),
      TIERS,
    );
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(
      text,
      /opus·max 1\.00 {2}\[workflow:reviewer\] Review the diff/,
    );
    assert.match(text, /asked claude-fable-5-1 → opus·max/);
  });

  test("a step moved off a forbidden model is shown too", () => {
    const sub: Attempt = {
      prompt: "fork",
      ms: 0,
      skipped: "fork keeps its parent's model",
      kind: "agent",
      agent: { label: "agent-9" },
      blocked: "claude-fable-5-1",
    };
    assert.match(
      statusReport({ ...base, attempts: [sub] }),
      /blocked claude-fable-5-1 → opus·high/,
    );
  });
});

describe("usage: what actually answered", () => {
  const routed = (): Attempt => ({ prompt: "plan it", ms: 641, decision });
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: "claude-opus-5-5",
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  });

  test("a stop chunk’s usage is kept on the turn", () => {
    const a = routed();
    addUsage(a, usage());
    assert.equal(a.usage?.model, "claude-opus-5-5");
    assert.equal(a.usage?.cache_read_input_tokens, 117_000);
  });

  test("a turn of several steps sums its counts and keeps the last model", () => {
    const a = routed();
    addUsage(a, usage({ input_tokens: 1000, output_tokens: 100 }));
    addUsage(
      a,
      usage({
        input_tokens: 2000,
        output_tokens: 200,
        model: "claude-opus-5-5-later",
      }),
    );
    assert.equal(a.usage?.input_tokens, 3000);
    assert.equal(a.usage?.output_tokens, 300);
    assert.equal(a.usage?.model, "claude-opus-5-5-later");
  });

  test("the cache ratio is what was read over everything the request carried", () => {
    assert.equal(cacheRatio(usage()), 0.9);
    assert.equal(
      cacheRatio(
        usage({
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ),
      0,
    );
  });

  test("the report confirms the model the API says answered", () => {
    const a = routed();
    addUsage(a, usage());
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-opus-5-5 ✓/);
    assert.match(text, /cache 90%/);
    assert.match(text, /130k in/);
  });

  test("a dated id still counts as the model that was asked for", () => {
    const a = routed();
    addUsage(a, usage({ model: "claude-opus-5-5-20260901" }));
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /claude-opus-5-5-20260901 ✓/,
    );
  });

  test("a different model answering is flagged, which is the whole point", () => {
    const a = routed();
    addUsage(a, usage({ model: "claude-fable-5-1" }));
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-fable-5-1 ≠ claude-opus-5-5/);
    assert.doesNotMatch(text, /✓/);
  });

  test("an unrouted subagent still shows what answered, with nothing to check against", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 0,
      skipped: "fork keeps its parent's model",
      kind: "agent",
      agent: { label: "x" },
    };
    addUsage(a, usage({ model: "claude-opus-5-5" }));
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /answered claude-opus-5-5/);
    assert.doesNotMatch(text, /[✓≠]/);
  });

  test("a turn with no usage yet gets one line, not a blank second one", () => {
    const lines = statusReport({ ...base, attempts: [routed()] }).split("\n");
    assert.equal(lines.filter((l) => l.includes("answered")).length, 0);
  });

  test("the usage line stays within one screen", () => {
    const a = routed();
    addUsage(
      a,
      usage({
        model: "claude-opus-5-5-20260901-preview",
        cache_read_input_tokens: 1_900_000,
      }),
    );
    for (const line of statusReport({ ...base, attempts: [a] }).split("\n"))
      assert.ok(line.length < 100, line);
  });
});

describe("usage footer", () => {
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: "claude-opus-5-5",
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  });
  const withUsage = (a: Attempt, u = usage()) => {
    addUsage(a, u);
    return a;
  };
  const routed = (): Attempt => ({ prompt: "plan it", ms: 641, decision });

  test("a turn with no usage has no footer", () => {
    assert.equal(usageFooter(routed()), null);
  });

  test("it is a fenced block, or markdown eats the indent and joins the lines", () => {
    const lines = usageFooter(withUsage(routed()))!.split("\n");
    assert.equal(lines[0], "```");
    assert.equal(lines.at(-1), "```");
    assert.match(lines[1]!, /^─+$/);
  });

  test("the jev line is what was asked for", () => {
    const footer = usageFooter(withUsage(routed()))!;
    assert.match(footer, /jev {2}opus·max · 97% · 641ms/);
  });

  test("the api line is what answered, with the cost", () => {
    const footer = usageFooter(withUsage(routed()))!;
    assert.match(
      footer,
      /api {2}claude-opus-5-5 ✓ · cache 90% · 130k in · 1k out/,
    );
  });

  test("a mismatch names both, which is the one case worth looking at", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ model: "claude-sonnet-5-5" })),
    )!;
    assert.match(footer, /api {2}claude-sonnet-5-5 ≠ claude-opus-5-5/);
  });

  test("a dated id is still the model that was asked for", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ model: "claude-opus-5-5-20260901" })),
    )!;
    assert.match(footer, /claude-opus-5-5-20260901 ✓/);
  });

  test("a fallback turn says so, and still checks what answered", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 1503,
      decision: fallbackDecision("timed out after 1500ms"),
    };
    const footer = usageFooter(withUsage(a))!;
    assert.match(
      footer,
      /jev {2}opus·high · fallback — timed out after 1500ms · 1503ms/,
    );
    assert.match(footer, /api {2}claude-opus-5-5 ✓ · cache 90%/);
  });

  test("an unrouted subagent reports what answered, with nothing to compare", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 0,
      skipped: "resumed, not re-asked",
    };
    const footer = usageFooter(withUsage(a, usage()))!;
    assert.match(footer, /jev {2}unrouted — resumed, not re-asked/);
    assert.match(footer, /api {2}claude-opus-5-5 · cache 90%/);
    assert.doesNotMatch(footer, /[✓≠]/);
  });

  test("the rule spans the widest line, and nothing wraps", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ cache_read_input_tokens: 1_900_000 })),
    )!;
    const lines = footer.split("\n");
    const rule = lines[1]!;
    const widest = Math.max(...lines.slice(2, -1).map((l) => [...l].length));
    assert.equal([...rule].length, widest);
    for (const line of lines) assert.ok([...line].length < 100, line);
  });
});

describe("turns that are not a typed prompt", () => {
  const notice = `<task-notification>
<task-id>a8fb449ee56c09</task-id>
<status>completed</status>
<summary>Agent "Review library-sync cluster" completed</summary>
</task-notification>`;

  test("a task notification is recognised and its summary kept as the prompt", () => {
    const a = attemptOf(notice, { ok: true, ms: 653, answers: {} as never }, [
      "opus",
    ]);
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, 'Agent "Review library-sync cluster" completed');
  });

  test("a notification without a summary falls back to its id", () => {
    const a = attemptOf(
      "<task-notification><task-id>abc123</task-id></task-notification>",
      { ok: false, ms: 0, reason: "x" },
      ["opus"],
    );
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, "task abc123");
  });

  test("a notification behind a harness's bracketed label is still one", () => {
    const a = attemptOf(
      `[SYSTEM NOTIFICATION - NOT USER INPUT]\n${notice}`,
      { ok: false, ms: 0, reason: "x" },
      ["opus"],
    );
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, 'Agent "Review library-sync cluster" completed');
  });

  test("a typed prompt has no kind", () => {
    assert.equal(
      attemptOf("plan it", { ok: false, ms: 0, reason: "x" }, ["opus"])
        .kind,
      undefined,
    );
  });

  const notify: Attempt = {
    prompt: 'Agent "Review library-sync cluster" completed',
    ms: 653,
    decision,
    kind: "notify",
  };

  test("the live line marks a notification turn, so a wake-up is not read as a reply to the person", () => {
    assert.equal(liveLine(notify), "> ✳️ `opus·max` · 97% · notify · 653ms");
  });

  test("the history tags it and shows the summary, not the envelope", () => {
    assert.match(
      statusReport({ ...base, attempts: [notify] }),
      /opus·max 0\.97 {2}\[notify\] Agent "Review library-sync cluster" complet/,
    );
  });

  test("the footer’s jev row carries the tag", () => {
    addUsage(notify, {
      model: "claude-opus-5-5",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    assert.match(
      usageFooter(notify)!,
      /jev {2}opus·max · 97% · notify · 653ms/,
    );
  });

  test("a subagent’s steps nobody routed are listed as unrouted, under the agent’s name", () => {
    const sub: Attempt = {
      prompt: "Review library-sync cluster",
      ms: 0,
      skipped: "no spawn seen, runs on its own model",
      kind: "agent",
      agent: { type: "Explore", label: "Review library-sync cluster" },
    };
    addUsage(sub, {
      model: "claude-opus-5-5",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const text = statusReport({ ...base, attempts: [sub] });
    assert.match(
      text,
      /unrouted — \[agent:Explore\] Review library-sync cluster/,
    );
    assert.match(text, /answered claude-opus-5-5 {2}cache 0%/);
  });
});

describe("a held turn", () => {
  const held: Attempt = {
    prompt: "rename the variable",
    ms: 512,
    decision: {
      tier: "opus",
      model: "claude-opus-5-5",
      effort: "medium",
      confidence: 1,
      held: "sonnet",
    },
  };

  test("the line says what Jev wanted and did not get, at the effort it asked for", () => {
    assert.equal(
      liveLine(held),
      "> ✳️ `opus·medium` · 100% · held:sonnet · 512ms",
    );
  });

  test("the history says so too, so a run of holds is visible", () => {
    assert.match(
      statusReport({ ...base, attempts: [held] }),
      /opus·medium 1\.00 held:sonnet {2}rename/,
    );
  });

  test("the footer carries it", () => {
    addUsage(held, {
      model: "claude-opus-5-5",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    assert.match(
      usageFooter(held)!,
      /jev {2}opus·medium · 100% · held:sonnet · 512ms/,
    );
  });

  test("a held turn is not marked low-confidence twice over", () => {
    const line = liveLine({
      prompt: "x",
      ms: 1,
      decision: { ...decisionFor("opus", 0.2), held: "haiku" },
    });
    assert.doesNotMatch(line, /\?/);
  });

  test("the status report says whether stickiness is on", () => {
    assert.match(statusReport(base), /sticky\s+off/);
    assert.match(
      statusReport({ ...base, sticky: 0.75 }),
      /sticky\s+on, switch needs 75%/,
    );
  });
});

describe("labels for Fable and a cap", () => {
  test("Fable reads as fable·high by default, and at the effort it was given", () => {
    assert.equal(rungOf(decisionFor("fable", 0.9)), "fable·high");
    assert.equal(rungOf(decisionFor("fable", 0.9, "max")), "fable·max");
  });

  test("a capped pick carries its mark, in the footer label too", () => {
    const capped = {
      ...decisionFor("opus", 0.6, "max"),
      capped: "fable" as const,
    };
    assert.deepEqual(marksOf(capped), ["capped:fable"]);
    assert.equal(labelOf(capped, true), "jev → opus·max · capped:fable");
  });
});

describe("where each setting came from", () => {
  test("nothing set reads as the defaults, the engine's filled-in ones too", () => {
    assert.deepEqual(configSourcesOf(undefined, {}), {
      fable: "default",
      fableConfidence: "default",
      minConfidence: "default",
      routeSubagents: "default",
      defaultModel: "default",
      defaultEffort: "default",
      haikuEffort: "default",
      sonnetEffort: "default",
      opusEffort: "default",
      fableEffort: "default",
      context: "default",
    });
    // What the engine hands in when nobody touched /config: every
    // userConfig default, filled in.
    const filled = configSourcesOf(
      {
        fable: "never",
        fableConfidence: 0.75,
        minConfidence: 0.5,
        routeSubagents: true,
        defaultModel: "opus",
        defaultEffort: "high",
        haikuEffort: "medium-high",
        sonnetEffort: "medium-max",
        opusEffort: "medium-max",
        fableEffort: "medium-max",
        context: "full",
      },
      {},
    );
    assert.ok(
      Object.values(filled).every((s) => s === "default"),
      JSON.stringify(filled),
    );
  });

  test("the ladder's settings have sources too: env over option over default", () => {
    const s = configSourcesOf(
      { defaultModel: "sonnet", opusEffort: "high", haikuEffort: "medium" },
      {
        JEV_ROUTER_DEFAULT_EFFORT: "MAX",
        JEV_ROUTER_HAIKU_EFFORT: "low-high",
        JEV_ROUTER_SONNET_EFFORT: "max-low",
        JEV_ROUTER_FABLE_EFFORT: "medium-max",
      },
    );
    assert.equal(s.defaultModel, "option");
    assert.equal(s.defaultEffort, "env", "case does not matter");
    assert.equal(s.haikuEffort, "env");
    assert.equal(s.sonnetEffort, "default", "an inverted band is skipped");
    assert.equal(s.opusEffort, "option");
    assert.equal(s.fableEffort, "env", "even when it says what the default says");
  });

  test("an option that differs from the default is an option", () => {
    const s = configSourcesOf({ fable: "open", minConfidence: 0.3 }, {});
    assert.equal(s.fable, "option");
    assert.equal(s.minConfidence, "option");
  });

  test("a valid env var wins, even when it says what the default says", () => {
    const s = configSourcesOf(
      { fable: "open" },
      { JEV_ROUTER_FABLE: "never", JEV_ROUTER_SUBAGENTS: "off" },
    );
    assert.equal(s.fable, "env");
    assert.equal(s.routeSubagents, "env");
  });

  test("an env var that cannot be read falls through to the option", () => {
    const s = configSourcesOf(
      { fable: "open" },
      { JEV_ROUTER_FABLE: "sometimes" },
    );
    assert.equal(s.fable, "option");
  });

  test("an unreadable JEV_ROUTER_CONTEXT is the env's, read as request", () => {
    const s = configSourcesOf(
      { context: "full" },
      { JEV_ROUTER_CONTEXT: "request-only" },
    );
    assert.equal(s.context, "env");
  });
});

describe("the sticky subcommand", () => {
  test("bare turns it on at the default bar", () => {
    const r = stickyCommand("", null);
    assert.equal(r.sticky, DEFAULT_STICKY_CONFIDENCE);
    assert.match(r.text, /75%/);
  });

  test("bare keeps a bar already set rather than resetting it", () => {
    assert.equal(stickyCommand("", 0.6).sticky, 0.6);
    assert.equal(stickyCommand("on", 0.6).sticky, 0.6);
  });

  test("off turns it off", () => {
    const r = stickyCommand("off", 0.6);
    assert.equal(r.sticky, null);
    assert.match(r.text, /freely/);
  });

  test("a number sets the bar and turns it on", () => {
    assert.equal(stickyCommand("0.6", null).sticky, 0.6);
    assert.equal(
      stickyCommand("60", null).sticky,
      0.6,
      "a percentage is read as one",
    );
    assert.equal(
      stickyCommand("60%", null).sticky,
      0.6,
      "and so is one with a sign",
    );
  });

  test("a bar outside the range is refused, and nothing changes", () => {
    for (const bad of ["0", "1", "100", "-2", "nonsense"]) {
      const r = stickyCommand(bad, 0.6);
      assert.equal(r.sticky, 0.6, bad);
      assert.match(r.text, /between/, bad);
    }
  });

  test("the reply says how to undo it, since the state is invisible otherwise", () => {
    assert.match(stickyCommand("", null).text, /\/jev sticky off/);
    assert.match(stickyCommand("off", 0.6).text, /\/jev sticky/);
  });
});
