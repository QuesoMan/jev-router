import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_CONFIG, type RouterSettings } from "../hooks/config.ts";
import {
  BAND_NAMES,
  bandName,
  bandOf,
  CEILING_EFFORT,
  CEILING_TIER,
  ceilingOf,
  clampEffort,
  DEFAULT_BANDS,
  DEFAULT_LADDER,
  ladderOf,
  type Ladder,
  criteriaOf,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_EFFORT,
  DEFAULT_STICKY_CONFIDENCE,
  DEFAULT_TIER,
  decisionFor,
  decisionOf,
  EFFORT_CRITERIA,
  EFFORT_RANGE,
  effortOf,
  effortScoreOf,
  EFFORTS,
  excludedTiers,
  fableGate,
  fableShareOf,
  fallbackDecision,
  familyOf,
  familyOfModel,
  floorOf,
  gatedDecision,
  guardTargetOf,
  isEffort,
  isForbiddenModel,
  isTier,
  levelSharesOf,
  MODEL_OF_FAMILY,
  modelOf,
  offeredPairs,
  offeredTiers,
  pairCriteriaOf,
  pairName,
  pairOf,
  pairPickOf,
  pairSharesOf,
  PAIRS,
  defaultPairOf,
  DEFAULT_PAIR_CLAUSE,
  familySharesOf,
  isPair,
  legacyDecisionOf,
  routeDecisionOf,
  THINKING,
  LIGHTER_TOO,
  WORK_KIND,
  revivedDecision,
  RUNGS,
  shareUpTo,
  spreadEffortOf,
  stickyDecision,
  stickyOf,
  thresholdOf,
  TIER_CRITERIA,
  tierOf,
  tierSharesOf,
  TIERS,
  type Decision,
  type Effort,
  type FableMode,
  type Pair,
  type Tier,
} from "../hooks/policy.ts";
import {
  concentrationOf,
  effortAnswerOf,
  sharesFor,
  tierAnswerOf,
  topOf,
} from "./jev-answers.ts";

const choice = (name: string, confidence = 0.9) => ({
  tier: { type: "choice", choice: name, confidence },
});

const answer = (
  name: string,
  confidence = 0.9,
  score?: unknown,
  effortConfidence?: unknown,
) => ({
  ...choice(name, confidence),
  ...(score === undefined
    ? {}
    : {
        effort: {
          type: "score",
          score,
          ...(effortConfidence === undefined
            ? {}
            : { confidence: effortConfidence }),
        },
      }),
});

const MODES: readonly FableMode[] = ["never", "hardest", "open"];

/**
 * Jev's answer as the live API sends it: probabilities over the tiers
 * (`share` on `name`, the rest where `sharesFor` puts Jev's doubt) and,
 * when given, an effort position with its level probabilities.
 */
const jev = (name: string, share = 0.9, score?: unknown) => ({
  tier: tierAnswerOf(sharesFor(name, share)),
  ...(score === undefined ? {} : { effort: effortAnswerOf(score) }),
});

/** The same, from a whole distribution. */
const jevOf = (shares: Record<string, number>, score?: unknown) => ({
  tier: tierAnswerOf(shares),
  ...(score === undefined ? {} : { effort: effortAnswerOf(score) }),
});

/**
 * Four tier answers measured from the live API (jev-1.14.0), as
 * distributions: the reason the floor reads probabilities. Each is named
 * for the request it answered.
 */
const LIVE = {
  bumpTimeout: { haiku: 0.59, sonnet: 0.41, opus: 0 },
  findConfigLoader: { haiku: 0, sonnet: 0.48, opus: 0.52 },
  whatDoesItReturn: { haiku: 0.29, sonnet: 0.48, opus: 0.23 },
  verboseFlag: { haiku: 0.01, sonnet: 0.91, opus: 0.08 },
} as const;
const at = (e: Effort) => EFFORTS.indexOf(e);

describe("the ladder", () => {
  test("families run cheapest first, with Fable on top", () => {
    assert.deepEqual([...TIERS], ["haiku", "sonnet", "opus", "fable"]);
  });

  test("efforts run least thinking first", () => {
    assert.deepEqual([...EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
  });

  test("every family maps to the model id the engine knows", () => {
    assert.deepEqual(MODEL_OF_FAMILY, {
      haiku: "claude-haiku-5-5",
      sonnet: "claude-sonnet-5-5",
      opus: "claude-opus-5-5",
      fable: "claude-fable-5-1",
    });
    for (const tier of TIERS) {
      assert.equal(familyOf(tier), tier);
      assert.equal(modelOf(tier), MODEL_OF_FAMILY[tier], tier);
    }
  });

  test("Opus at high effort is the default, Opus at max the ceiling", () => {
    assert.equal(DEFAULT_TIER, "opus");
    assert.equal(DEFAULT_EFFORT, "high");
    assert.equal(CEILING_TIER, "opus");
    assert.equal(CEILING_EFFORT, "max");
  });

  test("the effort ranges are the ones the person set", () => {
    assert.deepEqual(EFFORT_RANGE, {
      haiku: { min: "medium", max: "high" },
      sonnet: { min: "medium", max: "max" },
      opus: { min: "medium", max: "max" },
      fable: { min: "medium", max: "max" },
    });
    for (const tier of TIERS) {
      const { min, max } = EFFORT_RANGE[tier];
      assert.ok(at(min) <= at(max), tier);
    }
    assert.equal(
      clampEffort(DEFAULT_TIER, DEFAULT_EFFORT),
      DEFAULT_EFFORT,
      "the default effort is inside the default family",
    );
    assert.equal(clampEffort(CEILING_TIER, CEILING_EFFORT), CEILING_EFFORT);
  });

  test("the deprecated RUNGS reads as each family at its default effort", () => {
    for (const tier of TIERS) {
      assert.deepEqual(RUNGS[tier], {
        family: tier,
        effort: clampEffort(tier, DEFAULT_EFFORT),
      });
    }
    assert.equal(RUNGS[DEFAULT_TIER].effort, "high");
  });

  test("type guards know both lists and nothing else", () => {
    for (const t of TIERS) assert.equal(isTier(t), true, t);
    for (const e of EFFORTS) assert.equal(isEffort(e), true, e);
    for (const bad of ["opus-high", "Opus", "", 3, null, undefined]) {
      assert.equal(isTier(bad), false, String(bad));
      assert.equal(isEffort(bad), false, String(bad));
    }
  });

  test("every family has criteria for Jev, under every Fable setting", () => {
    for (const mode of MODES) {
      const criteria = criteriaOf(mode);
      assert.deepEqual(Object.keys(criteria).sort(), [...TIERS].sort(), mode);
      for (const tier of TIERS) assert.ok(criteria[tier].length > 0, tier);
    }
  });

  test("TIER_CRITERIA is the default setting's criteria", () => {
    assert.deepEqual(TIER_CRITERIA, criteriaOf("never"));
  });

  test("the fallback is never Fable, under any setting", () => {
    const d = fallbackDecision("down");
    assert.equal(d.tier, DEFAULT_TIER);
    for (const mode of MODES) {
      assert.equal(isForbiddenModel(d.model, mode), false, mode);
    }
  });
});

describe("the effort clamp", () => {
  test("Haiku never runs at low", () => {
    assert.equal(clampEffort("haiku", "low"), "medium");
  });

  test("Haiku never runs above high", () => {
    assert.equal(clampEffort("haiku", "xhigh"), "high");
    assert.equal(clampEffort("haiku", "max"), "high");
  });

  test("Haiku keeps medium and high as asked", () => {
    assert.equal(clampEffort("haiku", "medium"), "medium");
    assert.equal(clampEffort("haiku", "high"), "high");
  });

  test("Sonnet, Opus and Fable never run at low but allow max", () => {
    for (const tier of ["sonnet", "opus", "fable"] as Tier[]) {
      assert.equal(clampEffort(tier, "low"), "medium", tier);
      for (const e of ["medium", "high", "xhigh", "max"] as Effort[]) {
        assert.equal(clampEffort(tier, e), e, `${tier} ${e}`);
      }
    }
  });

  test("no family, at any effort, lands outside its range", () => {
    for (const tier of TIERS) {
      const { min, max } = EFFORT_RANGE[tier];
      for (const e of EFFORTS) {
        const got = at(clampEffort(tier, e));
        assert.ok(got >= at(min) && got <= at(max), `${tier} ${e}`);
      }
    }
  });
});

describe("effortOf", () => {
  test("a whole score is the level at that index", () => {
    EFFORTS.forEach((e, i) => assert.equal(effortOf(i), e));
  });

  test("a fractional score rounds to the nearest level", () => {
    assert.equal(effortOf(1.4), "medium");
    assert.equal(effortOf(1.5), "high");
    assert.equal(effortOf(2.6), "xhigh");
    assert.equal(effortOf(3.49), "xhigh");
  });

  test("a score off either end is held to the scale", () => {
    assert.equal(effortOf(-3), "low");
    assert.equal(effortOf(-0.4), "low");
    assert.equal(effortOf(9), "max");
    assert.equal(effortOf(Number.POSITIVE_INFINITY), DEFAULT_EFFORT);
  });

  test("a score that is not a finite number reads as the default effort", () => {
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, "3", null, undefined, {}]) {
      assert.equal(effortOf(bad), DEFAULT_EFFORT, String(bad));
    }
  });

  test("the criteria are one line per level, in order", () => {
    assert.equal(EFFORT_CRITERIA.length, EFFORTS.length);
    for (const line of EFFORT_CRITERIA) assert.ok(line.length > 0);
  });

  test("high is ordinary real work, max only the exceptional and high-stakes", () => {
    const high = EFFORT_CRITERIA[at("high")] ?? "";
    const max = EFFORT_CRITERIA[at("max")] ?? "";
    assert.match(high, /ordinary real work/i);
    assert.match(high, /most tasks/i);
    assert.match(high, /planning/i);
    assert.match(high, /review/i);
    assert.match(max, /exceptional/i);
    assert.match(max, /high-stakes|costly/i);
    assert.match(max, /hard but ordinary work is not this/i);
    assert.doesNotMatch(max, /planning|review|research/i);
  });
});

describe("criteria by Fable setting", () => {
  test("the families below the default read the same in every setting", () => {
    for (const tier of ["haiku", "sonnet"] as Tier[]) {
      assert.equal(criteriaOf("hardest")[tier], criteriaOf("never")[tier], tier);
      assert.equal(criteriaOf("open")[tier], criteriaOf("never")[tier], tier);
    }
  });

  test("Haiku is only for what no language model could get wrong", () => {
    const line = criteriaOf("never").haiku;
    assert.match(line, /no language model could get\s+wrong/i);
    assert.match(line, /any doubt/i);
  });

  test("Sonnet is simple implementation with nothing hard to decide", () => {
    const line = criteriaOf("never").sonnet;
    assert.match(line, /simple implementation/i);
    assert.match(line, /really simple/i);
    assert.match(line, /relatively simple/i);
    assert.match(line, /nothing hard to decide/i);
  });

  test("Opus owns ordinary planning, research, review and verification", () => {
    for (const mode of ["never", "hardest"] as FableMode[]) {
      const line = criteriaOf(mode).opus;
      assert.match(line, /planning/i, mode);
      assert.match(line, /research/i, mode);
      assert.match(line, /review/i, mode);
      assert.match(line, /verif/i, mode);
      assert.match(line, /debugging/i, mode);
      assert.match(line, /several files/i, mode);
    }
  });

  test("the exceptional hard cases are opus_max's, said by its effort, not by Opus's line", () => {
    for (const mode of ["never", "hardest"] as FableMode[]) {
      assert.doesNotMatch(criteriaOf(mode).opus, /exceptional/i, mode);
      const pairs = pairCriteriaOf(offeredTiers(new Set(), mode), mode);
      assert.match(pairs.opus_max!, /exceptional/i, mode);
      assert.match(pairs.opus_max!, /resisted ordinary debugging/i, mode);
      assert.doesNotMatch(pairs.opus_medium!, /exceptional/i, mode);
    }
    assert.equal(criteriaOf("never").opus, criteriaOf("hardest").opus);
  });

  test("no family line says it is the default", () => {
    for (const mode of MODES) {
      for (const tier of TIERS) {
        assert.doesNotMatch(criteriaOf(mode)[tier], /default/i, `${mode} ${tier}`);
      }
    }
  });

  test("under open, Opus is implementation incl. the hard kind, and Fable takes the thinking", () => {
    const opus = criteriaOf("open").opus;
    assert.match(opus, /implementation/i);
    assert.match(opus, /hard\s+implementation/i);
    assert.match(opus, /review/i);
    assert.doesNotMatch(opus, /planning|research|architecture/i);
    const fable = criteriaOf("open").fable;
    for (const kind of [/planning/i, /architecture/i, /systematic debugging/i, /research/i]) {
      assert.match(fable, kind);
    }
  });

  test("under hardest, Fable is only what even Opus at max would miss", () => {
    const fable = criteriaOf("hardest").fable;
    assert.match(fable, /exceptional few/i);
    assert.match(fable, /Opus at max effort would likely fall short/i);
    assert.doesNotMatch(fable, /planning|research/i);
  });

  test("under never, the Fable line only says it is not offered", () => {
    assert.match(criteriaOf("never").fable, /not offered/i);
    assert.notEqual(criteriaOf("never").fable, criteriaOf("hardest").fable);
    assert.notEqual(criteriaOf("hardest").fable, criteriaOf("open").fable);
  });

  test("criteriaOf hands back a fresh record, so a caller cannot edit the policy", () => {
    const mine = criteriaOf("never");
    mine.haiku = "anything";
    assert.notEqual(criteriaOf("never").haiku, "anything");
  });
});

describe("the Fable guard", () => {
  const fableIds = [
    "claude-fable-5-1",
    "claude-fable-5-1-20260901",
    "fable",
    "Fable",
    "FABLE[1m]",
    "us.anthropic.claude-fable-5-1-v1:0",
  ];
  const underCeiling = [
    "claude-opus-5-5",
    "claude-opus-5-5-20260601",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "opus",
    "sonnet",
    "haiku",
    "inherit",
    "",
  ];

  test("by default a Fable id is refused however it is spelled", () => {
    for (const model of fableIds) {
      assert.equal(isForbiddenModel(model), true, model);
      assert.equal(isForbiddenModel(model, "never"), true, model);
    }
  });

  test("under hardest an unrouted request for Fable is still refused", () => {
    for (const model of fableIds) {
      assert.equal(isForbiddenModel(model, "hardest"), true, model);
    }
  });

  test("under open nothing is refused", () => {
    for (const model of [...fableIds, ...underCeiling]) {
      assert.equal(isForbiddenModel(model, "open"), false, model);
    }
    assert.equal(isForbiddenModel(undefined, "open"), false);
  });

  test("everything at or under the ceiling is allowed in every setting", () => {
    for (const mode of MODES) {
      for (const model of underCeiling) {
        assert.equal(isForbiddenModel(model, mode), false, `${mode} ${model}`);
      }
      assert.equal(isForbiddenModel(undefined, mode), false, mode);
    }
  });

  test("every family but Fable runs on an allowed model by default", () => {
    for (const tier of TIERS) {
      assert.equal(isForbiddenModel(modelOf(tier)), tier === "fable", tier);
    }
  });
});

describe("offered tiers and exclusions", () => {
  const none = new Set<Tier>();

  test("by default Fable is never offered", () => {
    assert.deepEqual(offeredTiers(none), ["haiku", "sonnet", "opus"]);
    assert.deepEqual(offeredTiers(none, "never"), ["haiku", "sonnet", "opus"]);
  });

  test("under hardest and open the whole ladder is offered", () => {
    assert.deepEqual(offeredTiers(none, "hardest"), [...TIERS]);
    assert.deepEqual(offeredTiers(none, "open"), [...TIERS]);
  });

  test("Fable can be excluded like any family when it is on", () => {
    const offered = offeredTiers(excludedTiers("fable"), "open");
    assert.deepEqual(offered, ["haiku", "sonnet", "opus"]);
  });

  test("Haiku and Sonnet can be excluded", () => {
    assert.deepEqual(offeredTiers(excludedTiers("haiku")), ["sonnet", "opus"]);
    assert.deepEqual(
      offeredTiers(excludedTiers("haiku,sonnet"), "hardest"),
      ["opus", "fable"],
    );
  });

  test("Opus, the default, is never excluded and always offered", () => {
    assert.deepEqual([...excludedTiers("opus")], []);
    assert.deepEqual([...excludedTiers(" OPUS , haiku")], ["haiku"]);
    for (const mode of MODES) {
      const all = excludedTiers(TIERS.join(","));
      assert.ok(offeredTiers(all, mode).includes("opus"), mode);
      assert.deepEqual(offeredTiers(all, mode), ["opus"], mode);
      // A set built by hand, past excludedTiers, still cannot drop it.
      assert.ok(offeredTiers(new Set(TIERS), mode).includes("opus"), mode);
    }
  });

  test("excluding everything never puts Fable on the table under never", () => {
    const all = excludedTiers(TIERS.join(","));
    assert.ok(!offeredTiers(all, "never").includes("fable"));
  });

  test("an unknown name in the exclude list is ignored", () => {
    assert.deepEqual([...excludedTiers("haiku, nonsense, fable")], ["haiku", "fable"]);
    assert.deepEqual([...excludedTiers(" Sonnet ")], ["sonnet"]);
    assert.deepEqual([...excludedTiers(undefined)], []);
    assert.deepEqual([...excludedTiers("")], []);
  });

  test("the old rung names are ignored rather than guessed at", () => {
    assert.deepEqual(
      [...excludedTiers("sonnet-medium,sonnet-high,opus-high,opus-max")],
      [],
    );
    assert.deepEqual([...excludedTiers("haiku,sonnet-medium")], ["haiku"]);
  });

  test("a Fable pick is refused when Fable was not offered", () => {
    assert.equal(decisionOf(choice("fable"), offeredTiers(none)), null);
    assert.equal(
      decisionOf(choice("fable"), offeredTiers(none, "hardest"))?.tier,
      "fable",
    );
  });
});

describe("decisions", () => {
  test("a family and effort Jev picked become that model at that effort", () => {
    const d = decisionOf(answer("sonnet", 0.8, 3, 0.7));
    assert.deepEqual(d, {
      tier: "sonnet",
      model: MODEL_OF_FAMILY.sonnet,
      effort: "xhigh",
      confidence: 0.8,
      effortConfidence: 0.7,
    });
  });

  test("Jev's effort is clamped into the family it picked", () => {
    assert.equal(decisionOf(answer("haiku", 0.9, 0))?.effort, "medium");
    assert.equal(decisionOf(answer("haiku", 0.9, 4))?.effort, "high");
    assert.equal(decisionOf(answer("opus", 0.9, 0))?.effort, "medium");
    assert.equal(decisionOf(answer("opus", 0.9, 4))?.effort, "max");
    assert.equal(decisionOf(answer("sonnet", 0.9, 1))?.effort, "medium");
  });

  test("without an effort answer the decision takes the default effort, clamped", () => {
    for (const tier of ["haiku", "sonnet", "opus"] as Tier[]) {
      const d = decisionOf(choice(tier));
      assert.equal(d?.effort, clampEffort(tier, DEFAULT_EFFORT), tier);
      assert.equal(d?.effortConfidence, undefined, tier);
    }
    assert.equal(decisionOf(choice("opus"))?.effort, "high");
  });

  test("a malformed effort answer is the default effort, not a lost decision", () => {
    for (const effort of [
      null,
      "max",
      { type: "choice", choice: "max" },
      { type: "score" },
      { type: "score", score: "4" },
      { type: "score", score: Number.NaN },
    ]) {
      const d = decisionOf({ ...choice("opus", 0.8), effort });
      assert.equal(d?.tier, "opus", JSON.stringify(effort));
      assert.equal(d?.effort, "high", JSON.stringify(effort));
      assert.equal(d?.effortConfidence, undefined, JSON.stringify(effort));
    }
  });

  test("a non-finite effort confidence is left off", () => {
    const d = decisionOf(answer("opus", 0.8, 2, Number.NaN));
    assert.equal(d?.effortConfidence, undefined);
    assert.equal("effortConfidence" in (d ?? {}), false);
  });

  test("decisionFor builds a decision, clamped, at the default effort when none is given", () => {
    assert.deepEqual(decisionFor("haiku", 0.7), {
      tier: "haiku",
      model: MODEL_OF_FAMILY.haiku,
      effort: "high",
      confidence: 0.7,
    });
    assert.equal(decisionFor("haiku", 0.7, "low").effort, "medium");
    assert.equal(decisionFor("haiku", 0.7, "max").effort, "high");
    assert.equal(decisionFor("opus", 0.7, "max").effort, "max");
  });

  test("a family that was not offered is refused", () => {
    const offered = offeredTiers(excludedTiers("haiku"));
    assert.equal(decisionOf(choice("haiku"), offered), null);
    assert.equal(decisionOf(choice("opus"), offered)?.tier, "opus");
  });

  test("the old rung names are refused as choices", () => {
    for (const name of ["opus-high", "opus-max", "sonnet-medium", "sonnet-high", "haiku-low"]) {
      assert.equal(decisionOf(choice(name)), null, name);
    }
  });

  test("malformed answers give no decision rather than a wrong one", () => {
    assert.equal(decisionOf(null), null);
    assert.equal(decisionOf("opus"), null);
    assert.equal(decisionOf({}), null);
    assert.equal(decisionOf({ effort: { type: "score", score: 2 } }), null);
    assert.equal(decisionOf({ tier: { type: "score", score: 1 } }), null);
    assert.equal(decisionOf({ tier: { type: "choice" } }), null);
    assert.equal(decisionOf({ tier: { type: "choice", choice: 3 } }), null);
    assert.equal(
      decisionOf({ tier: { type: "choice", choice: "gpt-5" } }),
      null,
    );
  });

  test("a missing confidence reads as no confidence, not as certainty", () => {
    const d = decisionOf({ tier: { type: "choice", choice: "opus" } });
    assert.equal(d?.confidence, 0);
    const nan = decisionOf({
      tier: { type: "choice", choice: "opus", confidence: Number.NaN },
    });
    assert.equal(nan?.confidence, 0);
  });

  test("a fallback runs on Opus at high effort and says why", () => {
    const d = fallbackDecision("timed out after 1500ms");
    assert.deepEqual(d, {
      tier: "opus",
      model: MODEL_OF_FAMILY.opus,
      effort: "high",
      confidence: 0,
      fallback: "timed out after 1500ms",
    });
  });

  test("a pick Jev made carries no fallback, floor, cap or hold", () => {
    const d = decisionOf(answer("opus", 0.9, 2));
    assert.equal(d?.fallback, undefined);
    assert.equal(d?.floored, undefined);
    assert.equal(d?.capped, undefined);
    assert.equal(d?.held, undefined);
  });
});

describe("decisions read back from storage", () => {
  test("a decision in today's shape comes back as it was", () => {
    const kept: Decision = {
      ...decisionFor("sonnet", 0.6, "xhigh"),
      effortConfidence: 0.4,
      held: "haiku",
    };
    assert.deepEqual(revivedDecision(JSON.parse(JSON.stringify(kept))), kept);
    const fallback = fallbackDecision("down");
    assert.deepEqual(revivedDecision({ ...fallback }), fallback);
  });

  test("a decision's distribution is kept and read back unchanged", () => {
    const fresh = decisionOf(jevOf(LIVE.whatDoesItReturn, 2), TIERS, DEFAULT_LADDER, 0.5);
    assert.ok(fresh?.probabilities);
    assert.deepEqual(revivedDecision(JSON.parse(JSON.stringify(fresh))), fresh);
    assert.deepEqual(
      revivedDecision(JSON.parse(JSON.stringify(fresh)), DEFAULT_LADDER, { clamp: false }),
      fresh,
    );
  });

  test("a decision kept before probabilities were comes back without them, its confidence a label", () => {
    const d = revivedDecision({ tier: "haiku", effort: "medium", confidence: 0.38 });
    assert.equal(d?.tier, "haiku");
    assert.equal(d?.confidence, 0.38);
    assert.equal("probabilities" in (d ?? {}), false);
  });

  test("a stored distribution that cannot be read is dropped, not the decision", () => {
    for (const probabilities of [null, "x", [1], { gpt: 1 }, { opus: "1" }]) {
      const d = revivedDecision({ tier: "opus", confidence: 1, probabilities });
      assert.equal(d?.tier, "opus", JSON.stringify(probabilities));
      assert.equal(d?.probabilities, undefined, JSON.stringify(probabilities));
    }
  });

  test("the old rung names are read as the family and effort they ran on", () => {
    const cases: [string, Tier, Effort][] = [
      ["opus-high", "opus", "high"],
      ["opus-max", "opus", "max"],
      ["sonnet-medium", "sonnet", "medium"],
      ["sonnet-high", "sonnet", "high"],
    ];
    for (const [old, tier, effort] of cases) {
      const d = revivedDecision({
        tier: old,
        model: "whatever",
        effort: "low",
        confidence: 0.8,
      });
      assert.equal(d?.tier, tier, old);
      assert.equal(d?.effort, effort, old);
      assert.equal(d?.model, MODEL_OF_FAMILY[tier], old);
      assert.equal(d?.confidence, 0.8, old);
    }
  });

  test("an old Haiku at low comes back clamped to medium", () => {
    const d = revivedDecision({
      tier: "haiku",
      model: "claude-haiku-5-5",
      effort: "low",
      confidence: 0.9,
    });
    assert.equal(d?.tier, "haiku");
    assert.equal(d?.effort, "medium");
  });

  test("an old Fable decision comes back on Fable", () => {
    const d = revivedDecision({
      tier: "fable",
      model: "claude-fable-5-1",
      effort: "high",
      confidence: 0.9,
    });
    assert.equal(d?.tier, "fable");
    assert.equal(d?.effort, "high");
  });

  test("old rung names in the marks are migrated, unknown ones dropped", () => {
    const d = revivedDecision({
      tier: "opus-max",
      model: "claude-opus-5-5",
      effort: "max",
      confidence: 0.6,
      held: "sonnet-high",
      floored: "nonsense",
      capped: "fable",
    });
    assert.equal(d?.held, "sonnet");
    assert.equal(d?.floored, undefined);
    assert.equal("floored" in (d ?? {}), false);
    assert.equal(d?.capped, "fable");
  });

  test("a stored effort out of range or missing is clamped or defaulted", () => {
    assert.equal(
      revivedDecision({ tier: "haiku", confidence: 1, effort: "max" })?.effort,
      "high",
    );
    assert.equal(revivedDecision({ tier: "opus", confidence: 1 })?.effort, "high");
    assert.equal(
      revivedDecision({ tier: "sonnet", confidence: 1, effort: "huge" })?.effort,
      "high",
    );
  });

  test("what is not a decision gives null rather than a crash", () => {
    for (const bad of [
      null,
      undefined,
      "opus-high",
      {},
      { tier: "gpt-5", confidence: 1 },
      { tier: "opus" },
      { tier: "opus", confidence: "0.9" },
      { tier: "opus", confidence: Number.NaN },
    ]) {
      assert.equal(revivedDecision(bad), null, JSON.stringify(bad));
    }
  });
});

describe("the Fable gate", () => {
  /** A Fable pick with `share` of Jev's probability on Fable, the rest on Opus. */
  const fable = (share: number, effort: Effort = "high"): Decision => ({
    ...decisionFor("fable", share, effort),
    probabilities: { opus: 1 - share, fable: share },
  });

  test("under open a Fable pick runs on Fable at any share, at Jev's effort", () => {
    for (const c of [0.01, 0.5, 0.99]) {
      const d = fableGate(fable(c, "xhigh"), "open", 0.75);
      assert.equal(d.tier, "fable");
      assert.equal(d.model, MODEL_OF_FAMILY.fable);
      assert.equal(d.effort, "xhigh");
      assert.equal(d.capped, undefined);
    }
  });

  test("under hardest a Fable pick with enough on Fable runs there at Jev's effort", () => {
    for (const effort of ["medium", "high", "max"] as Effort[]) {
      const d = fableGate(fable(0.9, effort), "hardest", 0.75);
      assert.equal(d.tier, "fable");
      assert.equal(d.model, "claude-fable-5-1");
      assert.equal(d.effort, effort);
      assert.equal(d.capped, undefined);
    }
  });

  test("under hardest P(fable) exactly at the bar runs on Fable", () => {
    assert.equal(fableGate(fable(0.75), "hardest", 0.75).tier, "fable");
    assert.equal(fableGate(fable(1), "hardest", 1).tier, "fable");
  });

  test("under hardest a Fable pick short of the bar runs on Opus at max, whatever effort Jev gave", () => {
    for (const effort of ["medium", "high", "max"] as Effort[]) {
      const fresh = { ...fable(0.74, effort), effortConfidence: 0.6 };
      const d = fableGate(fresh, "hardest", 0.75);
      assert.equal(d.tier, "opus", effort);
      assert.equal(d.model, MODEL_OF_FAMILY.opus, effort);
      assert.equal(d.effort, "max", effort);
      assert.equal(d.capped, "fable", "what was picked is kept");
      assert.ok(
        Math.abs(d.confidence - 0.26) < 1e-9,
        "the share behind the ceiling, P(tier <= opus)",
      );
      assert.deepEqual(d.probabilities, fresh.probabilities, "the distribution is kept");
      assert.equal(d.effortConfidence, 0.6);
    }
  });

  test("the bar is on P(fable), not on the answer's confidence", () => {
    // However peaked the answer was, it is the share on Fable that decides.
    const flat: Decision = {
      ...decisionFor("fable", 0.99, "high"),
      probabilities: { haiku: 0.3, sonnet: 0.05, opus: 0.05, fable: 0.6 },
    };
    assert.equal(fableShareOf(flat), 0.6);
    assert.equal(fableGate(flat, "hardest", 0.75).tier, "opus");
    assert.equal(fableGate(flat, "hardest", 0.6).tier, "fable");
  });

  test("a Fable pick with no distribution behind it is capped under hardest", () => {
    // A choice-only answer, or a decision kept before probabilities were.
    const bare = decisionFor("fable", 0.99, "high");
    assert.equal(fableShareOf(bare), 0);
    const d = fableGate(bare, "hardest", 0.75);
    assert.equal(d.tier, "opus");
    assert.equal(d.capped, "fable");
    assert.equal(d.confidence, 0.99, "no distribution: the number it had");
  });

  test("the bar is the person's: a higher one caps more", () => {
    assert.equal(fableGate(fable(0.8), "hardest", 0.9).tier, "opus");
    assert.equal(fableGate(fable(0.8), "hardest", 0.5).tier, "fable");
  });

  test("under never a Fable decision is capped whatever its share", () => {
    for (const c of [0, 0.5, 1]) {
      const d = fableGate(fable(c), "never", 0.75);
      assert.equal(d.tier, "opus");
      assert.equal(d.effort, "max");
      assert.equal(d.capped, "fable");
      assert.equal(isForbiddenModel(d.model), false);
    }
  });

  test("a cap keeps floored only while Opus is still above the top choice", () => {
    const fromSonnet = { ...fable(0.42), floored: "sonnet" as Tier };
    assert.equal(fableGate(fromSonnet, "hardest", 0.75).floored, "sonnet");
    const fromOpus = { ...fable(0.42), floored: "opus" as Tier };
    const d = fableGate(fromOpus, "hardest", 0.75);
    assert.equal(d.tier, "opus");
    assert.equal(d.floored, undefined, "Opus is the top choice itself");
    assert.equal(d.capped, "fable");
  });

  test("every other family passes the gate untouched in every setting", () => {
    for (const mode of MODES) {
      for (const tier of TIERS.filter((t) => t !== "fable")) {
        for (const effort of EFFORTS) {
          const fresh = decisionFor(tier, 0.1, effort);
          assert.equal(fableGate(fresh, mode, 0.75), fresh, `${mode} ${tier}`);
        }
      }
    }
  });
});

describe("confidence floor", () => {
  test("unset, empty or nonsense falls back to the default", () => {
    assert.equal(floorOf(undefined), DEFAULT_CONFIDENCE_FLOOR);
    assert.equal(floorOf(""), DEFAULT_CONFIDENCE_FLOOR);
    assert.equal(floorOf("  "), DEFAULT_CONFIDENCE_FLOOR);
    assert.equal(floorOf("high"), DEFAULT_CONFIDENCE_FLOOR);
    assert.equal(floorOf("-0.2"), DEFAULT_CONFIDENCE_FLOOR);
    assert.equal(floorOf("150"), DEFAULT_CONFIDENCE_FLOOR);
  });

  test("a ratio or a percentage is taken", () => {
    assert.equal(floorOf("0.6"), 0.6);
    assert.equal(floorOf("70"), 0.7, "a percentage is read as one");
    assert.equal(floorOf("1"), 1);
    assert.equal(floorOf("100"), 1);
  });

  test("0 is allowed, and turns the floor off", () => {
    assert.equal(floorOf("0"), 0);
  });
});

describe("the tier from Jev's probabilities", () => {
  const T3 = ["haiku", "sonnet", "opus"] as Tier[];
  const pick = (shares: unknown, bar: number, offered: readonly Tier[] = T3) =>
    tierOf(shares, offered, bar)?.tier;

  test("at 0.5 the pick is the median of the live distributions", () => {
    assert.equal(pick(LIVE.bumpTimeout, 0.5), "haiku");
    assert.equal(pick(LIVE.findConfigLoader, 0.5), "opus");
    assert.equal(pick(LIVE.whatDoesItReturn, 0.5), "sonnet");
    assert.equal(pick(LIVE.verboseFlag, 0.5), "sonnet");
  });

  test("a higher bar leans toward the stronger model", () => {
    assert.equal(pick(LIVE.bumpTimeout, 0.6), "sonnet");
    assert.equal(pick(LIVE.findConfigLoader, 0.6), "opus");
    assert.equal(pick(LIVE.whatDoesItReturn, 0.6), "sonnet");
    assert.equal(pick(LIVE.verboseFlag, 0.6), "sonnet");
  });

  test("0 takes Jev's top choice, not the cheapest tier with any probability", () => {
    assert.equal(pick(LIVE.bumpTimeout, 0), "haiku");
    assert.equal(pick(LIVE.findConfigLoader, 0), "opus");
    assert.equal(pick(LIVE.whatDoesItReturn, 0), "sonnet");
    assert.equal(pick(LIVE.verboseFlag, 0), "sonnet");
  });

  test("the one-constant edit Jev kept off Opus never lands on Opus", () => {
    for (const bar of [0.1, 0.5, 0.6, 0.9, 1]) {
      assert.notEqual(pick(LIVE.bumpTimeout, bar), "opus", String(bar));
    }
  });

  test("the pick carries the share behind it and Jev's top choice", () => {
    const at5 = tierOf(LIVE.bumpTimeout, T3, 0.5);
    assert.equal(at5?.top, "haiku");
    assert.ok(Math.abs((at5?.cumulative ?? 0) - 0.59) < 1e-9);
    const at6 = tierOf(LIVE.bumpTimeout, T3, 0.6);
    assert.equal(at6?.tier, "sonnet");
    assert.equal(at6?.top, "haiku");
    assert.equal(at6?.cumulative, 1, "every last bit says Sonnet or cheaper");
    const loader = tierOf(LIVE.findConfigLoader, T3, 0.5);
    assert.equal(loader?.tier, "opus");
    assert.equal(loader?.top, "opus");
  });

  test("a share exactly at the bar is taken, so the bar is a minimum", () => {
    assert.equal(pick({ haiku: 0.5, sonnet: 0.5 }, 0.5), "haiku");
    assert.equal(pick({ haiku: 0.59, sonnet: 0.41 }, 1), "sonnet", "0.59 + 0.41 reaches 1");
  });

  test("a tier not offered is dropped and the rest renormalised", () => {
    const noHaiku = ["sonnet", "opus"] as Tier[];
    const shares = tierSharesOf(LIVE.whatDoesItReturn, noHaiku);
    assert.equal(shares?.haiku, undefined);
    assert.ok(Math.abs((shares?.sonnet ?? 0) - 0.48 / 0.71) < 1e-9);
    assert.ok(Math.abs((shares?.opus ?? 0) - 0.23 / 0.71) < 1e-9);
    assert.equal(pick(LIVE.whatDoesItReturn, 0.5, noHaiku), "sonnet");
    assert.equal(pick(LIVE.bumpTimeout, 0.5, noHaiku), "sonnet");
    // Probability on Fable while Fable is not offered counts for nothing.
    assert.equal(pick({ opus: 0.3, fable: 0.7 }, 0.5), "opus");
  });

  test("Fable is the top of the order only when it is offered", () => {
    const shares = { sonnet: 0.3, opus: 0.15, fable: 0.55 };
    assert.equal(pick(shares, 0.5, TIERS), "fable");
    // Without Fable, Sonnet holds 0.3 of the 0.45 left: two thirds.
    assert.equal(pick(shares, 0.5, T3), "sonnet");
    assert.equal(pick(shares, 0.3, TIERS), "sonnet");
  });

  test("every offered tier is present in the shares, at 0 when Jev gave none", () => {
    assert.deepEqual(tierSharesOf({ sonnet: 1 }, T3), { haiku: 0, sonnet: 1, opus: 0 });
  });

  test("nothing readable gives no pick, so the caller falls back to the choice", () => {
    for (const bad of [undefined, null, "opus", [0.5, 0.5], {}, { opus: "1" }, { opus: -1 }, { fable: 1 }]) {
      assert.equal(tierOf(bad, T3, 0.5), undefined, JSON.stringify(bad));
    }
  });

  test("a tie for the top goes to Jev's own choice, else the cheaper", () => {
    const tie = { haiku: 0.45, sonnet: 0.1, opus: 0.45 };
    assert.equal(tierOf(tie, T3, 0, "opus")?.top, "opus");
    assert.equal(tierOf(tie, T3, 0)?.top, "haiku");
  });

  test("shareUpTo adds up the ladder from the cheapest", () => {
    assert.equal(shareUpTo({ haiku: 0.2, sonnet: 0.3, opus: 0.5 }, "haiku"), 0.2);
    assert.equal(shareUpTo({ haiku: 0.2, sonnet: 0.3, opus: 0.5 }, "sonnet"), 0.5);
    assert.equal(shareUpTo({ sonnet: 1 }, "fable"), 1);
  });
});

describe("decisions at the floor", () => {
  test("decisionOf at the floor picks by the cumulative share", () => {
    const d = decisionOf(jevOf(LIVE.bumpTimeout, 2), ["haiku", "sonnet", "opus"], DEFAULT_LADDER, 0.5);
    assert.equal(d?.tier, "haiku");
    assert.ok(Math.abs((d?.confidence ?? 0) - 0.59) < 1e-9, "the share, not the 0.38 concentration");
    assert.equal(d?.floored, undefined, "the top choice itself");
    assert.deepEqual(d?.probabilities, { haiku: 0.59, sonnet: 0.41, opus: 0 });
  });

  test("a pick moved above Jev's top choice is marked floored with the top choice", () => {
    const d = decisionOf(jevOf(LIVE.bumpTimeout, 2), TIERS, DEFAULT_LADDER, 0.6);
    assert.equal(d?.tier, "sonnet");
    assert.equal(d?.floored, "haiku");
    assert.equal(d?.confidence, 1);
  });

  test("a pick at the top choice carries no floored mark", () => {
    for (const shares of Object.values(LIVE)) {
      const d = decisionOf(jevOf(shares), TIERS, DEFAULT_LADDER, 0.5);
      assert.equal(d?.floored, undefined, JSON.stringify(shares));
    }
  });

  test("a pick below the top choice is not floored: the median sits under a split", () => {
    const split = { haiku: 0.45, sonnet: 0.08, opus: 0.47 };
    const d = decisionOf(jevOf(split), TIERS, DEFAULT_LADDER, 0.5);
    assert.equal(d?.tier, "sonnet");
    assert.equal(d?.floored, undefined);
  });

  test("the effort is clamped into the band of the tier picked, not the top choice's", () => {
    // Jev's max for work it split 45/55 between Haiku and Opus: at a bar of
    // 0.6 the pick is Opus, and Opus may think at max where Haiku may not.
    const d = decisionOf(jev("haiku", 0.55, 4), TIERS, DEFAULT_LADDER, 0.6);
    assert.equal(d?.tier, "opus");
    assert.equal(d?.floored, "haiku");
    assert.equal(d?.effort, "max");
  });

  test("with no bar, decisionOf is Jev's top choice", () => {
    assert.equal(decisionOf(jev("haiku", 0.3, 2))?.tier, "opus", "the top of a 30/70 split");
    assert.equal(decisionOf(jev("haiku", 0.6, 2))?.tier, "haiku");
  });

  test("missing probabilities fall back to the choice, its confidence kept for the label", () => {
    const d = decisionOf(answer("haiku", 0.3, 2), TIERS, DEFAULT_LADDER, 0.9);
    assert.equal(d?.tier, "haiku", "nothing to read a cumulative share from");
    assert.equal(d?.confidence, 0.3);
    assert.equal(d?.probabilities, undefined);
    assert.equal(d?.floored, undefined);
  });

  test("malformed probabilities fall back to the choice too", () => {
    for (const probabilities of [null, "lots", [0.2, 0.8], { gpt: 1 }, { haiku: "1" }]) {
      const raw = { tier: { type: "choice", choice: "sonnet", confidence: 0.4, probabilities } };
      const d = decisionOf(raw, TIERS, DEFAULT_LADDER, 0.5);
      assert.equal(d?.tier, "sonnet", JSON.stringify(probabilities));
      assert.equal(d?.probabilities, undefined, JSON.stringify(probabilities));
    }
  });

  test("probabilities only on a tier not offered fall back to the choice, and refuse it", () => {
    const raw = { tier: tierAnswerOf({ fable: 1 }) };
    assert.equal(decisionOf(raw, ["haiku", "sonnet", "opus"], DEFAULT_LADDER, 0.5), null);
  });
});

describe("the effort answer", () => {
  test("the position is the answer, rounded to the nearest level", () => {
    assert.equal(effortScoreOf({ type: "score", score: 0.95 }), 0.95);
    assert.equal(effortOf(effortScoreOf({ type: "score", score: 0.95 })), "medium");
    assert.equal(effortOf(effortScoreOf(effortAnswerOf(2.6))), "xhigh");
  });

  test("probabilities keyed by level as a string are read", () => {
    assert.deepEqual(
      levelSharesOf({ "0": 0.39, "1": 0.29, "2": 0.3, "3": 0.02, "4": 0 })?.map((p) =>
        Math.round(p * 100),
      ),
      [39, 29, 30, 2, 0],
    );
    assert.deepEqual(levelSharesOf([0, 0, 1, 0, 0]), [0, 0, 1, 0, 0]);
    for (const bad of [undefined, null, "x", {}, { "0": "1" }, { "9": 1 }]) {
      assert.equal(levelSharesOf(bad), undefined, JSON.stringify(bad));
    }
  });

  test("with no position, the position is worked out from the level probabilities", () => {
    const at = effortScoreOf({
      type: "score",
      probabilities: { "0": 0.39, "1": 0.29, "2": 0.3, "3": 0.02 },
    });
    assert.ok(Math.abs((at ?? -1) - 0.95) < 1e-9);
    assert.equal(effortScoreOf({ type: "score" }), undefined);
    assert.equal(effortScoreOf({ type: "choice", score: 2 }), undefined);
  });

  test("the effort's confidence gates nothing", () => {
    for (const confidence of [0, 0.1, 0.99]) {
      const raw = { ...choice("opus"), effort: { type: "score", score: 4, confidence } };
      assert.equal(decisionOf(raw)?.effort, "max", String(confidence));
    }
  });
});

describe("sticky routing", () => {
  test("off by default, so a session routes as it always has", () => {
    assert.equal(stickyOf(undefined), false);
    assert.equal(stickyOf(""), false);
    assert.equal(stickyOf("0"), false);
    assert.equal(stickyOf("false"), false);
  });

  test("the flag is set the ways people actually set flags", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      assert.equal(stickyOf(on), true, on);
    }
  });

  test("the bar has a default and takes one from the environment", () => {
    assert.equal(thresholdOf(undefined), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("0.6"), 0.6);
    assert.equal(thresholdOf("60"), 0.6, "a percentage is read as one");
  });

  test("an unusable bar falls back rather than pinning every turn", () => {
    assert.equal(thresholdOf("nonsense"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("-1"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("0"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("101"), DEFAULT_STICKY_CONFIDENCE);
  });

  test("the first turn of a session has nothing to hold to", () => {
    const d = stickyDecision(decisionFor("haiku", 0.2), null, 0.75);
    assert.equal(d.tier, "haiku");
    assert.equal(d.held, undefined);
  });

  test("an effort change on the same model is never a hold, however shaky", () => {
    const down = stickyDecision(
      decisionFor("opus", 0.1, "medium"),
      decisionFor("opus", 0.9, "max"),
      0.75,
    );
    assert.equal(down.tier, "opus");
    assert.equal(down.effort, "medium");
    assert.equal(down.held, undefined);

    const sonnet = stickyDecision(
      decisionFor("sonnet", 0.1, "medium"),
      decisionFor("sonnet", 0.9, "xhigh"),
      0.75,
    );
    assert.equal(sonnet.effort, "medium");
    assert.equal(sonnet.held, undefined);
  });

  test("a move up is never held, however shaky", () => {
    const d = stickyDecision(
      decisionFor("opus", 0.1, "max"),
      decisionFor("haiku", 0.9),
      0.75,
    );
    assert.equal(d.tier, "opus");
    assert.equal(d.model, MODEL_OF_FAMILY.opus);
    assert.equal(d.effort, "max");
    assert.equal(d.held, undefined);
  });

  test("a shaky move down is held on the previous model, at the fresh effort", () => {
    const d = stickyDecision(
      { ...decisionFor("sonnet", 0.6, "medium"), effortConfidence: 0.5 },
      decisionFor("opus", 0.9, "max"),
      0.75,
    );
    assert.equal(d.tier, "opus");
    assert.equal(d.model, MODEL_OF_FAMILY.opus);
    assert.equal(d.effort, "medium", "the new effort, on the old model");
    assert.equal(d.held, "sonnet", "what Jev wanted is kept");
    assert.equal(d.confidence, 0.6, "a choice-only pick keeps the only number it has");
    assert.equal(d.effortConfidence, 0.5);
  });

  test("a held turn's effort is clamped into the held family's range", () => {
    // Sonnet at max held on Haiku would be past Haiku's high.
    const d = stickyDecision(
      decisionFor("haiku", 0.6, "high"),
      decisionFor("sonnet", 0.9, "max"),
      0.75,
    );
    assert.equal(d.tier, "sonnet");
    assert.equal(d.effort, "high");
    assert.equal(d.held, "haiku");
    for (const held of TIERS) {
      for (const effort of EFFORTS) {
        const got = stickyDecision(
          decisionFor("haiku", 0.1, effort),
          decisionFor(held === "fable" ? "opus" : held, 0.9),
          0.75,
        );
        const { min, max } = EFFORT_RANGE[got.tier];
        assert.ok(
          at(got.effort) >= at(min) && at(got.effort) <= at(max),
          `${held} ${effort}`,
        );
      }
    }
  });

  test("a confident move down goes through", () => {
    const d = stickyDecision(
      decisionFor("haiku", 0.8, "medium"),
      decisionFor("opus", 0.9),
      0.75,
    );
    assert.equal(d.tier, "haiku");
    assert.equal(d.model, MODEL_OF_FAMILY.haiku);
    assert.equal(d.effort, "medium");
    assert.equal(d.held, undefined);
  });

  test("confidence exactly at the bar switches, so the bar is a minimum", () => {
    assert.equal(
      stickyDecision(
        decisionFor("sonnet", 0.75),
        decisionFor("opus", 0.9),
        0.75,
      ).tier,
      "sonnet",
    );
  });

  test("a previous decision in an unknown shape is never held to", () => {
    const stale = { ...decisionFor("opus", 0.9), tier: "opus-high" } as unknown as Decision;
    const d = stickyDecision(decisionFor("haiku", 0.1), stale, 0.75);
    assert.equal(d.tier, "haiku");
    assert.equal(d.held, undefined);
  });
});

describe("stickiness reads the cumulative share", () => {
  /** A fresh pick decided from a distribution at the default floor. */
  const fresh = (shares: Record<string, number>, score = 2) => {
    const d = decisionOf(jevOf(shares, score), ["haiku", "sonnet", "opus"], DEFAULT_LADDER, 0.5);
    assert.ok(d);
    return d;
  };
  const opus = decisionFor("opus", 0.9, "high");

  test("a move down is held while less than the bar says the cheaper model is enough", () => {
    // Taken at the floor with 59% behind it, held at a bar of 75%.
    const d = stickyDecision(fresh(LIVE.bumpTimeout), opus, 0.75);
    assert.equal(d.tier, "opus");
    assert.equal(d.held, "haiku");
    assert.deepEqual(d.probabilities, fresh(LIVE.bumpTimeout).probabilities);
  });

  test("a move down goes through once enough says the cheaper model is enough", () => {
    // 91% on Sonnet plus 1% on Haiku: 92% says Sonnet or cheaper will do.
    const d = stickyDecision(fresh(LIVE.verboseFlag), opus, 0.75);
    assert.equal(d.tier, "sonnet");
    assert.equal(d.held, undefined);
    // 77% of a flat answer says Sonnet or cheaper, though no tier has half.
    const flat = stickyDecision(fresh(LIVE.whatDoesItReturn), opus, 0.75);
    assert.equal(flat.tier, "sonnet");
    assert.equal(flat.held, undefined);
  });

  test("the share is read from the distribution, whatever the confidence says", () => {
    const d: Decision = {
      ...decisionFor("sonnet", 0.1, "medium"),
      probabilities: { haiku: 0.4, sonnet: 0.4, opus: 0.2 },
    };
    assert.equal(stickyDecision(d, opus, 0.75).tier, "sonnet", "80% says Sonnet or cheaper");
    assert.equal(stickyDecision(d, opus, 0.85).held, "sonnet");
  });

  test("a held turn's share is the share behind the tier it runs on", () => {
    // 70% says Sonnet or cheaper: under the bar, so the turn stays on Opus,
    // and all of Jev's probability says Opus or cheaper is enough.
    const d = stickyDecision(fresh({ haiku: 0, sonnet: 0.7, opus: 0.3 }), opus, 0.75);
    assert.equal(d.tier, "opus");
    assert.equal(d.held, "sonnet");
    assert.ok(Math.abs(d.confidence - 1) < 1e-9, `${d.confidence}`);
    // Held on Sonnet, the share is Haiku plus Sonnet, not Haiku alone.
    const sonnet = decisionFor("sonnet", 0.9, "high");
    const h = stickyDecision(fresh({ haiku: 0.55, sonnet: 0.3, opus: 0.15 }), sonnet, 0.75);
    assert.equal(h.tier, "sonnet");
    assert.equal(h.held, "haiku");
    assert.ok(Math.abs(h.confidence - 0.85) < 1e-9, `${h.confidence}`);
  });

  test("moves up and same-model moves are never held", () => {
    const up = stickyDecision(fresh(LIVE.findConfigLoader), decisionFor("haiku", 0.9), 0.99);
    assert.equal(up.tier, "opus");
    assert.equal(up.held, undefined);
    const same = stickyDecision(fresh(LIVE.findConfigLoader), opus, 0.99);
    assert.equal(same.held, undefined);
  });
});

describe("the pipeline: decisionOf at the floor, Fable gate, then stickiness", () => {
  const gate = (fable: FableMode, fableConfidence = 0.75, minConfidence = 0.5) => ({
    fable,
    fableConfidence,
    minConfidence,
  });
  const route = (
    raw: unknown,
    g: ReturnType<typeof gate>,
    previous: Decision | null = null,
    threshold: number | null = null,
  ): Decision => {
    const offered = offeredTiers(new Set(), g.fable);
    const picked = decisionOf(raw, offered, DEFAULT_LADDER, g.minConfidence);
    const gated = picked === null ? fallbackDecision("none") : gatedDecision(picked, g);
    return threshold === null ? gated : stickyDecision(gated, previous, threshold);
  };

  test("gatedDecision is the Fable gate", () => {
    for (const mode of MODES) {
      for (const tier of TIERS) {
        for (const effort of EFFORTS) {
          for (const c of [0.1, 0.6, 0.9]) {
            const fresh: Decision = {
              ...decisionFor(tier, c, effort),
              probabilities: { [tier]: c, opus: 1 - c },
            };
            assert.deepEqual(
              gatedDecision(fresh, gate(mode)),
              fableGate(fresh, mode, 0.75),
              `${mode} ${tier} ${effort} ${c}`,
            );
          }
        }
      }
    }
  });

  test("by default a Fable answer was never offered, so it falls back to Opus at high", () => {
    const d = route(jevOf({ fable: 1 }, 4), gate("never"));
    assert.equal(d.tier, "opus");
    assert.equal(d.effort, "high");
    assert.ok(d.fallback);
  });

  test("Fable probability while Fable is off counts for nothing", () => {
    const d = route(jevOf({ sonnet: 0.3, fable: 0.7 }, 2), gate("never"));
    assert.equal(d.tier, "sonnet", "all that is left is on Sonnet");
    assert.equal(d.capped, undefined);
  });

  test("a Fable pick under hardest is gated on P(fable)", () => {
    const sure = route(jev("fable", 0.8, 3), gate("hardest"));
    assert.equal(sure.tier, "fable");
    assert.equal(sure.effort, "xhigh");
    const shaky = route(jev("fable", 0.6, 3), gate("hardest"));
    assert.equal(shaky.tier, "opus");
    assert.equal(shaky.effort, "max");
    assert.equal(shaky.capped, "fable");
  });

  test("the floor can move a pick up into Fable, and the gate still sees it", () => {
    // Top choice Sonnet, but only 58% says Opus or cheaper: at 0.6, Fable.
    const shares = { sonnet: 0.44, opus: 0.14, fable: 0.42 };
    const open = route(jevOf(shares, 2), gate("open", 0.75, 0.6));
    assert.equal(open.tier, "fable");
    assert.equal(open.floored, "sonnet");
    const hardest = route(jevOf(shares, 2), gate("hardest", 0.75, 0.6));
    assert.equal(hardest.tier, "opus");
    assert.equal(hardest.capped, "fable");
    assert.equal(hardest.floored, "sonnet", "Opus is still above the top choice");
  });

  test("a confident Fable pick under hardest survives the whole pipeline", () => {
    const d = route(
      jev("fable", 0.8, 3),
      gate("hardest"),
      decisionFor("haiku", 0.9),
      0.75,
    );
    assert.equal(d.tier, "fable");
    assert.equal(d.effort, "xhigh");
    assert.equal(d.held, undefined, "a move up is never held");
  });

  test("the floor applies under every setting", () => {
    for (const mode of MODES) {
      const d = route(jev("haiku", 0.3, 1), gate(mode));
      assert.equal(d.tier, "opus", mode);
      assert.equal(d.effort, "medium", `${mode}: Jev's effort, in Opus's band`);
      assert.equal(d.floored, undefined, `${mode}: Opus is the top choice of a 30/70 split`);
      const moved = route(jev("haiku", 0.45, 1), gate(mode));
      assert.equal(moved.tier, "opus", mode);
      assert.equal(moved.floored, undefined, `${mode}: top choice again`);
      const above = route(jev("haiku", 0.55, 1), gate(mode, 0.75, 0.6));
      assert.equal(above.tier, "opus", mode);
      assert.equal(above.floored, "haiku", mode);
    }
  });

  test("Opus picks span medium to max on Jev's effort alone", () => {
    const efforts = [0, 1, 2, 3, 4].map(
      (score) => route(jev("opus", 0.9, score), gate("never")).effort,
    );
    assert.deepEqual(efforts, ["medium", "medium", "high", "xhigh", "max"]);
  });

  test("stickiness sees the gated pick: a capped turn after Opus is no switch", () => {
    const d = route(
      jev("fable", 0.6, 2),
      gate("hardest"),
      decisionFor("opus", 0.9),
      0.75,
    );
    assert.equal(d.tier, "opus");
    assert.equal(d.effort, "max");
    assert.equal(d.capped, "fable");
    assert.equal(d.held, undefined);
  });

  test("stickiness still holds a shaky switch down, at Jev's effort", () => {
    const d = route(
      jev("sonnet", 0.6, 1),
      gate("open"),
      decisionFor("opus", 0.9, "max"),
      0.75,
    );
    assert.equal(d.tier, "opus");
    assert.equal(d.effort, "medium");
    assert.equal(d.held, "sonnet");
  });

  test("a turn is never held on Fable, so a hold cannot slip past the gate", () => {
    for (const mode of ["hardest", "open"] as FableMode[]) {
      const d = route(
        jev("sonnet", 0.6, 2),
        gate(mode),
        decisionFor("fable", 0.9),
        0.75,
      );
      assert.equal(d.tier, "sonnet", mode);
      assert.equal(d.model, MODEL_OF_FAMILY.sonnet, mode);
      assert.equal(d.held, undefined, mode);
    }
  });
});

/** The ladder a router runs on with `over` set on top of the defaults. */
const ladderWith = (over: Partial<RouterSettings> = {}): Ladder =>
  ladderOf({ ...DEFAULT_CONFIG, ...over });

describe("band names", () => {
  test("one level is a band of that level alone, two are min and max", () => {
    assert.deepEqual(bandOf("high"), { min: "high", max: "high" });
    assert.deepEqual(bandOf("medium-max"), { min: "medium", max: "max" });
    assert.deepEqual(bandOf("high-high"), { min: "high", max: "high" });
  });

  test("case, padding and the en dash or .. separator are read", () => {
    assert.deepEqual(bandOf(" Medium - XHIGH "), { min: "medium", max: "xhigh" });
    assert.deepEqual(bandOf("low–high"), { min: "low", max: "high" });
    assert.deepEqual(bandOf("low..high"), { min: "low", max: "high" });
  });

  test("an inverted band, junk or a non-string is no band", () => {
    for (const bad of [
      "max-medium",
      "high-low",
      "",
      "medium-",
      "-max",
      "low-medium-high",
      "medium high",
      "opus",
      3,
      null,
      undefined,
      { min: "low", max: "max" },
    ]) {
      assert.equal(bandOf(bad), undefined, JSON.stringify(bad));
    }
  });

  test("a band is written one way: a level alone, else min-max", () => {
    assert.equal(bandName({ min: "high", max: "high" }), "high");
    assert.equal(bandName({ min: "medium", max: "high" }), "medium-high");
  });

  test("there are fifteen bands, every one reading back as itself, low to high", () => {
    assert.equal(BAND_NAMES.length, 15);
    assert.equal(new Set(BAND_NAMES).size, 15);
    assert.equal(BAND_NAMES[0], "low");
    assert.equal(BAND_NAMES[BAND_NAMES.length - 1], "max");
    for (const name of BAND_NAMES) {
      const band = bandOf(name);
      assert.ok(band, name);
      assert.equal(bandName(band), name);
    }
  });

  test("the default bands are the ones the deprecated EFFORT_RANGE names", () => {
    assert.equal(EFFORT_RANGE, DEFAULT_BANDS);
    assert.equal(DEFAULT_CONFIG.haikuEffort, bandName(DEFAULT_BANDS.haiku));
    assert.equal(DEFAULT_CONFIG.opusEffort, bandName(DEFAULT_BANDS.opus));
  });
});

describe("the ladder from settings", () => {
  test("the default settings are the default ladder, with nothing to report", () => {
    assert.deepEqual(ladderWith(), {
      bands: DEFAULT_BANDS,
      defaultTier: "opus",
      defaultEffort: "high",
    });
    assert.deepEqual(ladderWith(), { ...DEFAULT_LADDER });
  });

  test("each family takes the band its setting names", () => {
    const ladder = ladderWith({
      haikuEffort: "high",
      sonnetEffort: "low-xhigh",
      opusEffort: "high-max",
      fableEffort: "max",
    });
    assert.deepEqual(ladder.bands, {
      haiku: { min: "high", max: "high" },
      sonnet: { min: "low", max: "xhigh" },
      opus: { min: "high", max: "max" },
      fable: { min: "max", max: "max" },
    });
  });

  test("a band that cannot be read is the default band", () => {
    const ladder = ladderWith({ opusEffort: "nonsense", haikuEffort: "max-low" });
    assert.deepEqual(ladder.bands.opus, DEFAULT_BANDS.opus);
    assert.deepEqual(ladder.bands.haiku, DEFAULT_BANDS.haiku);
  });

  test("the default model is the setting's", () => {
    for (const tier of ["haiku", "sonnet", "opus"] as Tier[]) {
      const ladder = ladderWith({ defaultModel: tier });
      assert.equal(ladder.defaultTier, tier);
      assert.equal(ladder.refusedTier, undefined);
    }
  });

  test("a default of Fable is refused unless Fable is open, and says so", () => {
    for (const fable of ["never", "hardest"] as FableMode[]) {
      const ladder = ladderWith({ fable, defaultModel: "fable" });
      assert.equal(ladder.defaultTier, "opus", fable);
      assert.equal(ladder.refusedTier, "fable", fable);
    }
    const open = ladderWith({ fable: "open", defaultModel: "fable" });
    assert.equal(open.defaultTier, "fable");
    assert.equal(open.refusedTier, undefined);
  });

  test("the default effort is clamped into a narrowed band, and says so", () => {
    const up = ladderWith({ opusEffort: "xhigh-max" });
    assert.equal(up.defaultEffort, "xhigh");
    assert.equal(up.clampedEffort, "high");

    const down = ladderWith({ defaultModel: "haiku", defaultEffort: "max" });
    assert.equal(down.defaultEffort, "high", "Haiku stops at high");
    assert.equal(down.clampedEffort, "max");

    const inside = ladderWith({ defaultEffort: "xhigh" });
    assert.equal(inside.defaultEffort, "xhigh");
    assert.equal(inside.clampedEffort, undefined);
  });

  test("a refused Fable default clamps the effort into Opus's band", () => {
    const ladder = ladderWith({
      defaultModel: "fable",
      defaultEffort: "medium",
      opusEffort: "high-max",
      fableEffort: "medium-max",
    });
    assert.equal(ladder.defaultTier, "opus");
    assert.equal(ladder.defaultEffort, "high");
    assert.equal(ladder.clampedEffort, "medium");
  });

  test("ceilingOf is Opus at the top of its band", () => {
    assert.deepEqual(ceilingOf(), { tier: "opus", effort: "max" });
    assert.deepEqual(ceilingOf(ladderWith({ opusEffort: "medium-high" })), {
      tier: "opus",
      effort: "high",
    });
  });
});

describe("decisions on a configured ladder", () => {
  test("a narrowed Opus band caps max picks to its top and lifts low ones", () => {
    const ladder = ladderWith({ opusEffort: "high" });
    assert.equal(decisionOf(answer("opus", 0.9, 4), TIERS, ladder)?.effort, "high");
    assert.equal(decisionOf(answer("opus", 0.9, 1), TIERS, ladder)?.effort, "high");
    assert.equal(clampEffort("opus", "max", ladder), "high");
  });

  test("a band that allows low lets Jev's low answer run at low", () => {
    const ladder = ladderWith({ sonnetEffort: "low-medium" });
    assert.equal(decisionOf(answer("sonnet", 0.9, 0), TIERS, ladder)?.effort, "low");
    assert.equal(decisionOf(answer("sonnet", 0.9, 4), TIERS, ladder)?.effort, "medium");
  });

  test("a missing effort answer is the ladder's default effort, clamped", () => {
    const ladder = ladderWith({ defaultEffort: "xhigh" });
    assert.equal(decisionOf(choice("opus"), TIERS, ladder)?.effort, "xhigh");
    assert.equal(decisionOf(choice("haiku"), TIERS, ladder)?.effort, "high");
    assert.equal(
      decisionOf(answer("sonnet", 0.9, "lots"), TIERS, ladder)?.effort,
      "xhigh",
    );
  });

  test("decisionFor with no effort takes the ladder's default effort", () => {
    const ladder = ladderWith({ defaultEffort: "medium" });
    assert.equal(decisionFor("opus", 0.9, undefined, ladder).effort, "medium");
    assert.equal(decisionFor("opus", 0.9).effort, "high", "the default ladder");
  });

  test("effortOf falls back to the effort it is given", () => {
    assert.equal(effortOf(undefined, "xhigh"), "xhigh");
    assert.equal(effortOf(Number.NaN, "medium"), "medium");
    assert.equal(effortOf(1, "max"), "medium", "a real score is not a fallback");
  });

  test("the fallback is the configured default model at its effort", () => {
    const d = fallbackDecision("down", ladderWith({ defaultModel: "sonnet" }));
    assert.equal(d.tier, "sonnet");
    assert.equal(d.model, MODEL_OF_FAMILY.sonnet);
    assert.equal(d.effort, "high");
    assert.equal(d.confidence, 0);
    assert.equal(d.fallback, "down");

    const narrowed = fallbackDecision(
      "down",
      ladderWith({ defaultModel: "haiku", defaultEffort: "max" }),
    );
    assert.equal(narrowed.tier, "haiku");
    assert.equal(narrowed.effort, "high");
  });

  test("a refused Fable default falls back on Opus, never on Fable", () => {
    for (const fable of ["never", "hardest"] as FableMode[]) {
      const d = fallbackDecision("down", ladderWith({ fable, defaultModel: "fable" }));
      assert.equal(d.tier, "opus", fable);
      assert.equal(isForbiddenModel(d.model, fable), false, fable);
    }
    const open = fallbackDecision(
      "down",
      ladderWith({ fable: "open", defaultModel: "fable" }),
    );
    assert.equal(open.tier, "fable");
  });

  test("the floor reads Jev's distribution, not the default: the same answer picks the same tier", () => {
    for (const defaultModel of ["haiku", "sonnet", "opus"]) {
      const ladder = ladderWith({ defaultModel });
      for (const [name, shares] of Object.entries(LIVE)) {
        assert.equal(
          decisionOf(jevOf(shares, 2), TIERS, ladder, 0.5)?.tier,
          decisionOf(jevOf(shares, 2), TIERS, DEFAULT_LADDER, 0.5)?.tier,
          `${defaultModel} ${name}`,
        );
      }
    }
  });

  test("a pick runs at Jev's effort in its own band, not the default's", () => {
    const ladder = ladderWith({
      defaultModel: "sonnet",
      defaultEffort: "medium",
      sonnetEffort: "medium-xhigh",
    });
    const d = decisionOf(jev("haiku", 0.45, 3), TIERS, ladder, 0.5);
    assert.equal(d?.tier, "opus");
    assert.equal(d?.effort, "xhigh");
  });

  test("a capped Fable pick lands at the top of a narrowed Opus band", () => {
    const ladder = ladderWith({ fable: "hardest", opusEffort: "medium-high" });
    const d = fableGate(
      {
        ...decisionFor("fable", 0.4, "max", ladder),
        probabilities: { opus: 0.6, fable: 0.4 },
      },
      "hardest",
      0.75,
      ladder,
    );
    assert.equal(d.tier, "opus");
    assert.equal(d.effort, "high");
    assert.equal(d.capped, "fable");
  });

  test("gatedDecision runs the gate on the ladder it is given", () => {
    const ladder = ladderWith({ defaultModel: "sonnet", fable: "hardest" });
    const gate = { fable: "hardest" as FableMode, fableConfidence: 0.75 };
    const haiku = decisionFor("haiku", 0.2, "medium", ladder);
    assert.deepEqual(gatedDecision(haiku, gate, ladder), haiku);
    const capped = gatedDecision(
      decisionFor("fable", 0.2, "high", ladder),
      gate,
      ladder,
    );
    assert.equal(capped.tier, "opus");
    assert.equal(capped.effort, "max");
  });

  test("a held turn's effort is clamped into the held model's configured band", () => {
    const ladder = ladderWith({ opusEffort: "xhigh-max" });
    const previous = decisionFor("opus", 0.9, "max", ladder);
    const fresh = decisionFor("sonnet", 0.4, "medium", ladder);
    const d = stickyDecision(fresh, previous, 0.75, ladder);
    assert.equal(d.tier, "opus");
    assert.equal(d.effort, "xhigh");
    assert.equal(d.held, "sonnet");
  });

  test("the default model is never excluded, and neither is Opus", () => {
    const ladder = ladderWith({ defaultModel: "sonnet" });
    const excluded = excludedTiers("sonnet, opus, haiku", ladder);
    assert.deepEqual([...excluded], ["haiku"]);
    assert.deepEqual(offeredTiers(new Set(TIERS), "never", ladder), [
      "sonnet",
      "opus",
    ]);
    assert.deepEqual(offeredTiers(excluded, "open", ladder), [
      "sonnet",
      "opus",
      "fable",
    ]);
  });

  test("a Fable default under open is kept on offer", () => {
    const ladder = ladderWith({ fable: "open", defaultModel: "fable" });
    assert.deepEqual([...excludedTiers("fable", ladder)], []);
    assert.deepEqual(offeredTiers(new Set(TIERS), "open", ladder), [
      "opus",
      "fable",
    ]);
  });
});

describe("stored decisions on a configured ladder", () => {
  test("a stored effort is re-clamped into the current band", () => {
    const ladder = ladderWith({ opusEffort: "high" });
    const kept = { ...decisionFor("opus", 0.9, "max"), floored: "haiku" };
    const d = revivedDecision(kept, ladder);
    assert.equal(d?.tier, "opus");
    assert.equal(d?.effort, "high");
    assert.equal(d?.floored, "haiku", "marks survive");
  });

  test("an old rung is migrated, then clamped into the current band", () => {
    assert.equal(
      revivedDecision(
        { tier: "opus-max", confidence: 0.8 },
        ladderWith({ opusEffort: "medium-xhigh" }),
      )?.effort,
      "xhigh",
    );
    assert.equal(
      revivedDecision(
        { tier: "sonnet-medium", confidence: 0.8 },
        ladderWith({ sonnetEffort: "high-max" }),
      )?.effort,
      "high",
    );
  });

  test("a stored effort that is missing takes the ladder's default, clamped", () => {
    const d = revivedDecision(
      { tier: "opus", confidence: 0.8 },
      ladderWith({ defaultEffort: "xhigh" }),
    );
    assert.equal(d?.effort, "xhigh");
  });

  test("reading back again with the same ladder changes nothing", () => {
    const ladder = ladderWith({ opusEffort: "medium-high" });
    const once = revivedDecision(
      { tier: "opus", effort: "max", confidence: 0.7 },
      ladder,
    );
    assert.deepEqual(revivedDecision(once, ladder), once);
  });

  test("a stored fallback keeps its family when the default model changes", () => {
    const kept = fallbackDecision("down");
    const d = revivedDecision(kept, ladderWith({ defaultModel: "sonnet" }));
    assert.equal(d?.tier, "opus");
    assert.equal(d?.fallback, "down");
  });
});

describe("the family a model belongs to", () => {
  test("ids, aliases and dated or provider ids name their family", () => {
    const cases: [string, Tier][] = [
      ["claude-haiku-5-5", "haiku"],
      ["haiku", "haiku"],
      ["claude-sonnet-5-5[1m]", "sonnet"],
      ["us.anthropic.claude-opus-5-5-v1:0", "opus"],
      ["claude-fable-5-1-20260901", "fable"],
    ];
    for (const [model, family] of cases) {
      assert.equal(familyOfModel(model), family, model);
    }
    for (const tier of TIERS) assert.equal(familyOfModel(modelOf(tier)), tier);
  });

  test("a model the ladder does not know has no family", () => {
    assert.equal(familyOfModel("gpt-9"), undefined);
    assert.equal(familyOfModel(undefined), undefined);
  });
});

describe("where the Fable guard sends a refused request", () => {
  test("a new user's ladder: the default, Opus at high", () => {
    assert.deepEqual(guardTargetOf(), { tier: "opus", effort: "high" });
  });

  test("a default below Opus is lifted to Opus, at the default's effort", () => {
    assert.deepEqual(guardTargetOf(ladderWith({ defaultModel: "haiku" })), {
      tier: "opus",
      effort: "high",
    });
    assert.deepEqual(
      guardTargetOf(ladderWith({ defaultModel: "sonnet", defaultEffort: "max" })),
      { tier: "opus", effort: "max" },
    );
  });

  test("the effort is held to Opus's band", () => {
    assert.deepEqual(
      guardTargetOf(
        ladderWith({
          defaultModel: "sonnet",
          defaultEffort: "max",
          opusEffort: "high",
        }),
      ),
      { tier: "opus", effort: "high" },
    );
  });

  test("it is never on a weaker model than a refused Jev pick of Fable", () => {
    for (const defaultModel of ["haiku", "sonnet", "opus"]) {
      const ladder = ladderWith({ defaultModel });
      const capped = fableGate(decisionFor("fable", 0.1), "never", 0.8, ladder);
      assert.equal(guardTargetOf(ladder).tier, capped.tier, defaultModel);
    }
  });
});

describe("the Fable gate and a default on Fable", () => {
  const open = ladderWith({ fable: "open", defaultModel: "fable" });
  const hardest = ladderWith({ fable: "hardest", defaultModel: "fable" });

  test("a fallback on Fable becomes the tighter ladder's fallback, reason kept", () => {
    const kept = fallbackDecision("timed out", open);
    assert.equal(kept.tier, "fable");
    for (const mode of ["hardest", "never"] as FableMode[]) {
      const ladder = ladderWith({ fable: mode, defaultModel: "fable" });
      const gated = fableGate(
        revivedDecision(kept, ladder) ?? kept,
        mode,
        0.8,
        ladder,
      );
      assert.deepEqual(gated, fallbackDecision("timed out", ladder), mode);
      assert.equal(gated.effort, "high", mode);
      assert.equal(gated.capped, undefined, mode);
    }
  });

  test("a pick moved up onto Fable under open is gated on P(fable) once the setting tightens", () => {
    const shares = { sonnet: 0.44, opus: 0.14, fable: 0.42 };
    const moved = decisionOf(jevOf(shares, 2), TIERS, open, 0.6);
    assert.equal(moved?.tier, "fable");
    assert.equal(moved?.floored, "sonnet");
    assert.ok(moved);
    const gated = fableGate(revivedDecision(moved, hardest) ?? moved, "hardest", 0.8, hardest);
    assert.deepEqual(
      { tier: gated.tier, effort: gated.effort, floored: gated.floored, capped: gated.capped },
      { tier: "opus", effort: "max", floored: "sonnet", capped: "fable" },
    );
    const sure = decisionOf(jevOf({ sonnet: 0.1, opus: 0.05, fable: 0.85 }, 2), TIERS, open, 0.6);
    assert.ok(sure);
    assert.equal(fableGate(revivedDecision(sure, hardest) ?? sure, "hardest", 0.8, hardest).tier, "fable");
  });

  test("Jev's own shaky Fable pick is still capped to the ceiling", () => {
    const gated = fableGate(
      decisionFor("fable", 0.5, "high"),
      "hardest",
      0.8,
      hardest,
    );
    assert.deepEqual(
      { tier: gated.tier, effort: gated.effort, capped: gated.capped },
      { tier: "opus", effort: "max", capped: "fable" },
    );
  });
});

describe("stickiness and a default that is not Opus", () => {
  const sonnet = ladderWith({ defaultModel: "sonnet" });
  const previous = decisionFor("opus", 0.9, "high");

  test("a fallback is never held: it runs on the default and says so", () => {
    const fresh = fallbackDecision("timed out", sonnet);
    const got = stickyDecision(fresh, previous, 0.75, sonnet);
    assert.deepEqual(got, fresh);
    assert.equal(got.held, undefined);
  });

  test("a held floored pick keeps its floored mark", () => {
    // Top choice Haiku at 55%; at a bar of 0.6 the pick moves up to Sonnet,
    // with 60% behind it, and a bar of 0.75 holds the switch down from Opus.
    const floored = decisionOf(
      jevOf({ haiku: 0.55, sonnet: 0.05, opus: 0.4 }, 1),
      TIERS,
      sonnet,
      0.6,
    );
    assert.ok(floored);
    assert.equal(floored.tier, "sonnet");
    const got = stickyDecision(floored, previous, 0.75, sonnet);
    assert.deepEqual(
      { tier: got.tier, held: got.held, floored: got.floored },
      { tier: "opus", held: "sonnet", floored: "haiku" },
    );
  });
});

describe("a decision read back as kept", () => {
  const narrow = ladderWith({ opusEffort: "medium-high" });

  test("clamp: false leaves the effort as stored", () => {
    const raw = {
      tier: "opus",
      model: "claude-opus-5-5",
      effort: "max",
      confidence: 0.8,
    };
    assert.equal(revivedDecision(raw, narrow)?.effort, "high");
    assert.equal(revivedDecision(raw, narrow, { clamp: false })?.effort, "max");
  });

  test("clamp: false still translates the old rung names", () => {
    const got = revivedDecision(
      { tier: "opus-max", model: "claude-opus-5-5", confidence: 0.8 },
      narrow,
      { clamp: false },
    );
    assert.deepEqual(
      { tier: got?.tier, effort: got?.effort, model: got?.model },
      { tier: "opus", effort: "max", model: "claude-opus-5-5" },
    );
  });
});

describe("criteria for a default that is not Opus", () => {
  const catchAll = /does not clearly fit another option/;

  test("a new user's criteria are the same with the ladder passed", () => {
    for (const mode of MODES) {
      assert.deepEqual(criteriaOf(mode, DEFAULT_LADDER), criteriaOf(mode), mode);
      assert.deepEqual(
        pairCriteriaOf(TIERS, mode, DEFAULT_LADDER),
        pairCriteriaOf(TIERS, mode),
        mode,
      );
    }
  });

  test("no family line carries the catch-all, whatever the default", () => {
    for (const defaultModel of TIERS) {
      for (const mode of MODES) {
        const lines = criteriaOf(mode, ladderWith({ fable: mode, defaultModel }));
        for (const tier of TIERS) {
          assert.doesNotMatch(lines[tier], catchAll, `${mode} ${defaultModel} ${tier}`);
        }
      }
    }
  });

  test("a Haiku default drops the line that any doubt rules Haiku out", () => {
    const line = criteriaOf("never", ladderWith({ defaultModel: "haiku" })).haiku;
    assert.doesNotMatch(line, /any doubt/i);
    assert.match(criteriaOf("never").haiku, /any doubt/i);
  });

  test("Opus keeps its work when it is not the default", () => {
    const top = criteriaOf("never", ladderWith({ defaultModel: "sonnet" })).opus;
    for (const kind of [/planning/i, /review/i, /debugging/i]) {
      assert.match(top, kind);
    }
    assert.equal(top, criteriaOf("never").opus);
    const open = criteriaOf(
      "open",
      ladderWith({ fable: "open", defaultModel: "sonnet" }),
    ).opus;
    assert.match(open, /hard implementation/i);
  });

  test("a Fable default under open puts the catch-all on its pair", () => {
    const ladder = ladderWith({ fable: "open", defaultModel: "fable" });
    const criteria = pairCriteriaOf(TIERS, "open", ladder);
    assert.match(criteria.fable_high!, catchAll);
    assert.doesNotMatch(criteria.opus_high!, catchAll);
  });

  test("a Fable default refused under hardest leaves Opus the default", () => {
    const ladder = ladderWith({ fable: "hardest", defaultModel: "fable" });
    assert.deepEqual(criteriaOf("hardest", ladder), criteriaOf("hardest"));
    assert.deepEqual(
      pairCriteriaOf(TIERS, "hardest", ladder),
      pairCriteriaOf(TIERS, "hardest"),
    );
  });
});

/** Every option of the `route` question, as Jev is shown them. */
const optionsOf = (
  mode: FableMode = "never",
  ladder: Ladder = DEFAULT_LADDER,
  offered: readonly Tier[] = offeredTiers(new Set(), mode, ladder),
) => pairCriteriaOf(offered, mode, ladder);

/**
 * A `route` answer as the live API sends it, from a distribution over
 * pairs: Jev's top pair as the choice, the concentration as confidence.
 */
const routeOf = (shares: Record<string, number>, choice?: string) => ({
  route: {
    type: "choice",
    choice: choice ?? topOf(shares),
    confidence: concentrationOf(shares, 10),
    probabilities: { ...shares },
  },
});

const DEFAULT_PAIRS: readonly Pair[] = [
  "haiku_medium",
  "haiku_high",
  "sonnet_medium",
  "sonnet_high",
  "sonnet_xhigh",
  "sonnet_max",
  "opus_medium",
  "opus_high",
  "opus_xhigh",
  "opus_max",
];

describe("pair names", () => {
  test("a pair is a family and an effort, joined by an underscore", () => {
    assert.equal(pairName("opus", "xhigh"), "opus_xhigh");
    assert.deepEqual(pairOf("haiku_medium"), { tier: "haiku", effort: "medium" });
    for (const pair of PAIRS) {
      const { tier, effort } = pairOf(pair)!;
      assert.equal(pairName(tier, effort), pair);
    }
    assert.equal(PAIRS.length, TIERS.length * EFFORTS.length);
  });

  test("anything else is no pair", () => {
    for (const bad of ["opus", "opus-high", "opus_huge", "gpt_high", "Opus_high", "", 3, null]) {
      assert.equal(isPair(bad), false, String(bad));
      assert.equal(pairOf(bad), undefined, String(bad));
    }
  });
});

describe("the route question's options", () => {
  test("by default they are every family below Fable at every effort in its band", () => {
    assert.deepEqual(offeredPairs(offeredTiers(new Set())), DEFAULT_PAIRS);
    assert.deepEqual(Object.keys(optionsOf()), DEFAULT_PAIRS);
  });

  test("under hardest and open Fable's band is offered on top", () => {
    for (const mode of ["hardest", "open"] as FableMode[]) {
      assert.deepEqual(Object.keys(optionsOf(mode)), [
        ...DEFAULT_PAIRS,
        "fable_medium",
        "fable_high",
        "fable_xhigh",
        "fable_max",
      ]);
    }
  });

  test("under never Fable is dropped even if a caller offers it", () => {
    const criteria = pairCriteriaOf(TIERS, "never");
    assert.deepEqual(Object.keys(criteria), DEFAULT_PAIRS);
    assert.doesNotMatch(JSON.stringify(criteria), /fable/i);
  });

  test("a narrowed band offers fewer pairs, a widened one more", () => {
    const narrow = ladderWith({ opusEffort: "high", sonnetEffort: "medium" });
    assert.deepEqual(Object.keys(optionsOf("never", narrow)), [
      "haiku_medium",
      "haiku_high",
      "sonnet_medium",
      "opus_high",
    ]);
    const wide = ladderWith({ haikuEffort: "low-max" });
    const keys = Object.keys(optionsOf("never", wide));
    assert.deepEqual(keys.slice(0, 5), [
      "haiku_low",
      "haiku_medium",
      "haiku_high",
      "haiku_xhigh",
      "haiku_max",
    ]);
    assert.equal(keys.length, 13);
  });

  test("only the offered families' pairs are shown", () => {
    const offered = offeredTiers(excludedTiers("haiku"));
    assert.deepEqual(
      Object.keys(optionsOf("never", DEFAULT_LADDER, offered)),
      DEFAULT_PAIRS.filter((p) => !p.startsWith("haiku")),
    );
  });

  test("each option is its family's kind of work, then how much thinking", () => {
    for (const mode of MODES) {
      const work = criteriaOf(mode);
      for (const [pair, line] of Object.entries(optionsOf(mode))) {
        const { tier, effort } = pairOf(pair)!;
        const thinking = THINKING[WORK_KIND[tier]][effort];
        assert.ok(line.startsWith(`${work[tier]} ${thinking}`), `${mode} ${pair}`);
      }
    }
  });

  test("no two options read the same", () => {
    for (const mode of MODES) {
      const lines = Object.values(optionsOf(mode));
      assert.equal(new Set(lines).size, lines.length, mode);
    }
  });

  test("exactly one option carries the default sentence, the ladder's default pair", () => {
    const ladders: [string, FableMode, Ladder][] = [];
    for (const mode of MODES) {
      ladders.push([`${mode} new user`, mode, ladderWith({ fable: mode })]);
      for (const defaultModel of ["haiku", "sonnet", "opus"] as Tier[]) {
        for (const defaultEffort of ["medium", "high", "max"] as Effort[]) {
          ladders.push([
            `${mode} ${defaultModel} ${defaultEffort}`,
            mode,
            ladderWith({ fable: mode, defaultModel, defaultEffort }),
          ]);
        }
      }
    }
    ladders.push(["open fable", "open", ladderWith({ fable: "open", defaultModel: "fable" })]);
    for (const [where, mode, ladder] of ladders) {
      const criteria = optionsOf(mode, ladder);
      const carrying = Object.entries(criteria)
        .filter(([, line]) => line.includes(DEFAULT_PAIR_CLAUSE))
        .map(([pair]) => pair);
      assert.deepEqual(carrying, [defaultPairOf(ladder)], where);
      const said = JSON.stringify(criteria).split(DEFAULT_PAIR_CLAUSE).length - 1;
      assert.equal(said, 1, `${where}: said once`);
    }
  });

  test("a new user's default sentence is on opus_high, and only Opus's line says nothing of it", () => {
    const criteria = optionsOf();
    assert.equal(defaultPairOf(), "opus_high");
    assert.ok(criteria.opus_high!.endsWith(DEFAULT_PAIR_CLAUSE));
    assert.doesNotMatch(criteria.opus_high!, /most tasks|most work/i);
  });

  test("a clamped default effort puts the sentence on the pair that runs", () => {
    const ladder = ladderWith({ defaultModel: "haiku", defaultEffort: "max" });
    assert.equal(defaultPairOf(ladder), "haiku_high");
    assert.match(optionsOf("never", ladder).haiku_high!, /does not clearly fit/);
  });

  test("more thinking on simple work is long or costly work, never hard deciding", () => {
    assert.equal(WORK_KIND.haiku, "simple");
    assert.equal(WORK_KIND.sonnet, "simple");
    assert.equal(WORK_KIND.opus, "demanding");
    assert.equal(WORK_KIND.fable, "demanding");
    const criteria = optionsOf();
    assert.match(criteria.sonnet_xhigh!, /simple work that is long or has many parts to keep straight/i);
    assert.match(criteria.sonnet_max!, /simple work where a slip would be costly to undo/i);
    for (const line of Object.values(THINKING.simple)) {
      assert.doesNotMatch(line, /hard|exceptional|novel|subtle|as possible/i, line);
    }
  });

  test("on demanding work high is ordinary real work and max only the exceptional", () => {
    const { high, max } = THINKING.demanding;
    assert.match(high, /ordinary real work/i);
    assert.doesNotMatch(high, /most tasks/i);
    assert.match(max, /exceptional/i);
    assert.match(max, /hard but ordinary work is not this/i);
  });

  /** What rules lighter work out of an option. */
  const FENCE = /hard but ordinary work is not this|harder than ordinary/i;

  test("a band of one level says nothing of thinking: its family's line is the whole option", () => {
    const ladder = ladderWith({ opusEffort: "max" });
    assert.equal(defaultPairOf(ladder), "opus_max");
    const criteria = optionsOf("never", ladder);
    assert.deepEqual(Object.keys(criteria).filter((p) => p.startsWith("opus")), ["opus_max"]);
    assert.equal(criteria.opus_max, `${criteriaOf("never", ladder).opus} ${DEFAULT_PAIR_CLAUSE}`);
    assert.doesNotMatch(criteria.opus_max!, FENCE);

    const haiku = optionsOf("never", ladderWith({ haikuEffort: "high" }));
    assert.equal(haiku.haiku_high, criteriaOf("never").haiku);
  });

  test("a band that starts above medium takes its family's lighter work on its lowest pair", () => {
    const ladder = ladderWith({ opusEffort: "xhigh-max" });
    assert.equal(defaultPairOf(ladder), "opus_xhigh");
    const criteria = optionsOf("never", ladder);
    assert.doesNotMatch(criteria.opus_xhigh!, FENCE);
    assert.match(criteria.opus_xhigh!, new RegExp(LIGHTER_TOO));
    assert.ok(criteria.opus_xhigh!.endsWith(DEFAULT_PAIR_CLAUSE));
    // The top of the band is still only for the exceptional.
    assert.match(criteria.opus_max!, /hard but ordinary work is not this/i);
    assert.doesNotMatch(criteria.opus_max!, new RegExp(LIGHTER_TOO));

    const haiku = optionsOf("never", ladderWith({ haikuEffort: "high-max" }));
    assert.match(haiku.haiku_high!, new RegExp(LIGHTER_TOO));
    assert.doesNotMatch(haiku.haiku_xhigh!, new RegExp(LIGHTER_TOO));
  });

  test("the default pair never rules ordinary work out, whatever effort it is at", () => {
    for (const defaultEffort of ["xhigh", "max"] as Effort[]) {
      const ladder = ladderWith({ defaultEffort });
      const home = defaultPairOf(ladder);
      assert.equal(home, `opus_${defaultEffort}`);
      const criteria = optionsOf("never", ladder);
      assert.doesNotMatch(criteria[home]!, FENCE, home);
      assert.ok(criteria[home]!.endsWith(DEFAULT_PAIR_CLAUSE), home);
    }
    // Off the default, the fences stay: max is still only the exceptional.
    assert.match(optionsOf("never", ladderWith({ defaultEffort: "max" })).opus_xhigh!, /harder than ordinary/i);
  });

  test("the default bands read every line as THINKING writes it", () => {
    for (const mode of MODES) {
      for (const [pair, line] of Object.entries(optionsOf(mode))) {
        const { tier, effort } = pairOf(pair)!;
        assert.ok(line.includes(THINKING[WORK_KIND[tier]][effort]), `${mode} ${pair}`);
        assert.doesNotMatch(line, new RegExp(LIGHTER_TOO), `${mode} ${pair}`);
      }
    }
  });

  test("the wording tables cover every effort, so a widened band always has a line", () => {
    for (const kind of ["simple", "demanding"] as const) {
      assert.deepEqual(Object.keys(THINKING[kind]), [...EFFORTS], kind);
    }
  });
});

describe("the family-first rule", () => {
  const offered = DEFAULT_PAIRS;

  test("the shares are renormalised over the offered pairs, the rest dropped", () => {
    const shares = pairSharesOf(
      { haiku_low: 0.2, fable_max: 0.2, sonnet_high: 0.3, opus_high: 0.3, opus: 1 },
      offered,
    )!;
    assert.deepEqual(Object.keys(shares), DEFAULT_PAIRS);
    assert.equal(shares.sonnet_high, 0.5);
    assert.equal(shares.opus_high, 0.5);
    assert.equal(shares.haiku_medium, 0);
  });

  test("a set that adds up to 1 is kept exactly as sent", () => {
    const sent = { sonnet_high: 0.59, opus_high: 0.41 };
    const shares = pairSharesOf(sent, offered)!;
    assert.equal(shares.sonnet_high, 0.59);
    assert.equal(shares.opus_high, 0.41);
  });

  test("nothing readable is no shares", () => {
    for (const raw of [undefined, null, "x", [0.5, 0.5], {}, { opus_high: 0 }, { opus_high: -1 }, { opus_high: "1" }, { haiku_low: 1 }]) {
      assert.equal(pairSharesOf(raw, offered), undefined, JSON.stringify(raw));
      assert.equal(pairPickOf(raw, offered), undefined, JSON.stringify(raw));
    }
  });

  test("family sums read pair and family shares alike", () => {
    assert.deepEqual(
      familySharesOf({ sonnet_medium: 0.25, sonnet_high: 0.25, opus_high: 0.5 }),
      { sonnet: 0.5, opus: 0.5 },
    );
    assert.deepEqual(familySharesOf({ opus: 0.7, haiku: 0.3 }), { haiku: 0.3, opus: 0.7 });
    assert.equal(shareUpTo({ sonnet_medium: 0.25, sonnet_high: 0.25, opus_high: 0.5 }, "sonnet"), 0.5);
  });

  /**
   * The comparison's ord-t4: the four pairs named in its audit, the rest
   * at 0. Renormalised, Sonnet holds 0.57 / 0.94 of it.
   */
  const ORD_T4 = { sonnet_medium: 0.05, sonnet_high: 0.39, sonnet_xhigh: 0.13, opus_high: 0.37 };

  test("ord-t4 at 0.5: Sonnet holds more than half, so Sonnet, at its likeliest effort", () => {
    const pick = pairPickOf(ORD_T4, offered, 0.5)!;
    assert.equal(pick.tier, "sonnet");
    assert.equal(pick.effort, "high");
    assert.equal(pick.top, "sonnet_high");
    assert.ok(Math.abs(pick.cumulative - 0.57 / 0.94) < 1e-9);
  });

  test("ord-t4 at 0: the family with the most, which is Sonnet too", () => {
    const pick = pairPickOf(ORD_T4, offered, 0)!;
    assert.equal(pick.tier, "sonnet");
    assert.equal(pick.effort, "high");
  });

  test("ord-t4 at a higher bar leans to Opus, at its likeliest effort, marked floored", () => {
    const pick = pairPickOf(ORD_T4, offered, 0.7)!;
    assert.equal(pick.tier, "opus");
    assert.equal(pick.effort, "high");
    assert.equal(pick.cumulative, 1);
    const d = decisionOf(routeOf(ORD_T4), TIERS, DEFAULT_LADDER, 0.7)!;
    assert.equal(`${d.tier}_${d.effort}`, "opus_high");
    assert.equal(d.floored, "sonnet");
  });

  test("ord-t4: a cumulative rule down the mixed pair list would have landed on an effort Jev gave 13%", () => {
    // What the rule replaced read: the cheapest pair whose running total,
    // in pair order, reaches the bar. Family first does not.
    const shares = pairSharesOf(ORD_T4, offered)!;
    let sum = 0;
    const naive = offered.find((p) => (sum += shares[p] ?? 0) >= 0.5);
    assert.equal(naive, "sonnet_xhigh");
    assert.equal(pairPickOf(ORD_T4, offered, 0.5)!.effort, "high");
  });

  test("the median can sit under the top pair: two Haiku pairs outweigh one Opus pair", () => {
    const split = { haiku_medium: 0.3, haiku_high: 0.25, opus_high: 0.45 };
    const pick = pairPickOf(split, offered, 0.5)!;
    assert.equal(pick.tier, "haiku");
    assert.equal(pick.effort, "medium");
    assert.equal(pick.top, "opus_high");
    const d = decisionOf(routeOf(split), TIERS, DEFAULT_LADDER, 0.5)!;
    assert.equal(d.floored, undefined, "below the top pair is not floored");
  });

  test("at 0 the family is the one with the most probability, not the top pair's", () => {
    const pick = pairPickOf({ haiku_medium: 0.3, haiku_high: 0.3, opus_high: 0.4 }, offered, 0)!;
    assert.equal(pick.tier, "haiku");
    assert.equal(pick.top, "opus_high");
  });

  test("a family share exactly at the bar is taken, so the bar is a minimum", () => {
    const pick = pairPickOf({ sonnet_high: 0.5, opus_high: 0.5 }, offered, 0.5)!;
    assert.equal(pick.tier, "sonnet");
  });

  test("a tie within the family goes to the lower effort, whatever Jev chose", () => {
    const shares = { opus_high: 0.5, opus_xhigh: 0.5 };
    assert.equal(pairPickOf(shares, offered, 0.5, "opus_xhigh")!.effort, "high");
    assert.equal(pairPickOf(shares, offered, 0, "opus_xhigh")!.effort, "high");
  });

  test("a tie between families at 0 goes to Jev's choice's family, else the cheaper", () => {
    const shares = { sonnet_medium: 0.5, opus_high: 0.5 };
    assert.equal(pairPickOf(shares, offered, 0, "opus_high")!.tier, "opus");
    assert.equal(pairPickOf(shares, offered, 0)!.tier, "sonnet");
  });

  test("a tie for the top pair goes to Jev's choice, else the cheaper", () => {
    const shares = { sonnet_high: 0.4, opus_medium: 0.2, opus_high: 0.4 };
    assert.equal(pairPickOf(shares, offered, 0.5, "opus_high")!.top, "opus_high");
    assert.equal(pairPickOf(shares, offered, 0.5)!.top, "sonnet_high");
    const d = decisionOf(routeOf(shares, "sonnet_high"), TIERS, DEFAULT_LADDER, 0.5)!;
    assert.equal(`${d.tier}_${d.effort}`, "opus_high");
    assert.equal(d.floored, "sonnet");
  });

  test("a bar of 1 takes the cheapest family that holds everything that is left", () => {
    const pick = pairPickOf({ haiku_medium: 0.59, sonnet_high: 0.41 }, offered, 1)!;
    assert.equal(pick.tier, "sonnet");
    assert.equal(pick.cumulative, 1);
  });
});

describe("a family holding under half takes its effort from the whole answer", () => {
  const offered = DEFAULT_PAIRS;

  /**
   * The live answer to a bare "looks good, ship it": haiku .47, sonnet .20,
   * opus .33. Sonnet is where half is reached, and `sonnet_max` (.07) tops
   * Sonnet's own pairs.
   */
  const SHIP_IT = {
    haiku_medium: 0.3, haiku_high: 0.17,
    sonnet_medium: 0.05, sonnet_high: 0.06, sonnet_xhigh: 0.02, sonnet_max: 0.07,
    opus_medium: 0.04, opus_high: 0.27, opus_xhigh: 0.01, opus_max: 0.01,
  };

  test("ship it: Sonnet, at the whole answer's median effort, not at the max its own 7% said", () => {
    const pick = pairPickOf(SHIP_IT, offered, 0.5)!;
    assert.equal(pick.tier, "sonnet");
    assert.equal(pick.effort, "high");
    assert.equal(spreadEffortOf(pairSharesOf(SHIP_IT, offered)!, ["sonnet_medium", "sonnet_high", "sonnet_xhigh", "sonnet_max"]), "high");
    const d = decisionOf(routeOf(SHIP_IT), TIERS, DEFAULT_LADDER, 0.5)!;
    assert.equal(`${d.tier}_${d.effort}`, "sonnet_high");
    assert.equal(d.floored, "haiku", "the family rule's mark is unchanged");
    assert.ok(Math.abs(d.confidence - 0.67) < 1e-9);
  });

  test("a family with a majority keeps its own likeliest pair, even against the whole answer's median", () => {
    // Sonnet holds .55; across every pair the median effort is medium.
    const shares = { sonnet_medium: 0.15, sonnet_max: 0.4, opus_medium: 0.45 };
    assert.equal(pairPickOf(shares, offered, 0.5)!.effort, "max");
    assert.equal(pairPickOf(shares, offered, 0)!.effort, "max");
  });

  test("exactly half is a majority: the family's own ranking stands", () => {
    const shares = { sonnet_medium: 0.2, sonnet_max: 0.3, opus_medium: 0.5 };
    const pick = pairPickOf(shares, offered, 0.5)!;
    assert.equal(pick.tier, "sonnet");
    assert.equal(pick.effort, "max");
  });

  test("the rule holds whatever picked the family, the top family at a bar of 0 included", () => {
    // Three-way split: Opus has the most at .4, a minority of the whole.
    const shares = { haiku_medium: 0.3, sonnet_medium: 0.3, opus_medium: 0.05, opus_max: 0.35 };
    const pick = pairPickOf(shares, offered, 0)!;
    assert.equal(pick.tier, "opus");
    assert.equal(pick.effort, "medium", "its own top pair said max, on 35%");
  });

  test("the median exactly at half goes to the lower effort", () => {
    // Efforts across the answer: medium .5, xhigh .35, max .15.
    const shares = { haiku_medium: 0.45, sonnet_medium: 0.05, sonnet_max: 0.15, opus_xhigh: 0.35 };
    const pick = pairPickOf(shares, offered, 0.5)!;
    assert.equal(pick.tier, "sonnet");
    assert.equal(pick.effort, "medium");
  });

  test("the median is clamped into the family's band, from above", () => {
    // At a bar of 0.4 Haiku is reached at .42, a minority; the median is max.
    const pick = pairPickOf({ haiku_high: 0.42, opus_max: 0.58 }, offered, 0.4)!;
    assert.equal(pick.tier, "haiku");
    assert.equal(pick.effort, "high", "Haiku's band tops out at high");
  });

  test("the median is clamped into the family's band, from below, on a narrowed ladder", () => {
    const ladder = ladderWith({ sonnetEffort: "high-max" });
    const shares = { haiku_medium: 0.45, sonnet_high: 0.1, opus_medium: 0.45 };
    const d = decisionOf(routeOf(shares), TIERS, ladder, 0.5)!;
    assert.equal(d.tier, "sonnet");
    assert.equal(d.effort, "high", "medium is below Sonnet's band");
  });

  test("the hold, the Fable gate and storage read the effort as decided", () => {
    const fresh = decisionOf(routeOf(SHIP_IT), TIERS, DEFAULT_LADDER, 0.5)!;
    const opus = decisionFor("opus", 1, "high");
    const held = stickyDecision(fresh, opus, DEFAULT_STICKY_CONFIDENCE);
    assert.equal(`${held.tier}_${held.effort}`, "opus_high");
    assert.equal(held.held, "sonnet");
    assert.equal(held.floored, "haiku");
    assert.deepEqual(revivedDecision(JSON.parse(JSON.stringify(fresh))), fresh);

    // A Fable pick on a minority under "hardest" is capped to the ceiling,
    // whatever effort the spread gave it.
    const hardest = offeredTiers(new Set(), "hardest");
    const thin = decisionOf(
      routeOf({ haiku_medium: 0.6, opus_high: 0.05, fable_high: 0.35 }),
      hardest,
      DEFAULT_LADDER,
      0.9,
    )!;
    assert.equal(`${thin.tier}_${thin.effort}`, "fable_medium");
    const capped = fableGate(thin, "hardest", 0.75);
    assert.equal(`${capped.tier}_${capped.effort}`, "opus_max");
    assert.equal(capped.capped, "fable");
  });
});

describe("route decisions", () => {
  test("a route answer becomes its family and effort, with the share behind the family", () => {
    const d = decisionOf(routeOf({ sonnet_medium: 0.2, sonnet_high: 0.6, opus_high: 0.2 }), TIERS, DEFAULT_LADDER, 0.5);
    assert.equal(d?.tier, "sonnet");
    assert.equal(d?.model, MODEL_OF_FAMILY.sonnet);
    assert.equal(d?.effort, "high");
    assert.ok(Math.abs((d?.confidence ?? 0) - 0.8) < 1e-9);
    assert.equal(d?.probabilities?.sonnet_high, 0.6);
    assert.equal("effortConfidence" in (d ?? {}), false);
    assert.equal(d?.fallback, undefined);
  });

  test("with no bar, decisionOf takes the family with the most probability", () => {
    const answer = routeOf({ haiku_medium: 0.45, opus_high: 0.55 });
    assert.equal(decisionOf(answer)?.tier, "opus");
    assert.equal(decisionOf(answer, TIERS, DEFAULT_LADDER, 0.4)?.tier, "haiku");
  });

  test("missing or unreadable probabilities fall back to the choice when it is an offered pair", () => {
    for (const probabilities of [undefined, null, "x", {}, { opus: 1 }]) {
      const d = decisionOf({ route: { type: "choice", choice: "sonnet_xhigh", confidence: 0.4, probabilities } });
      assert.equal(d?.tier, "sonnet", JSON.stringify(probabilities));
      assert.equal(d?.effort, "xhigh", JSON.stringify(probabilities));
      assert.equal(d?.confidence, 0.4, JSON.stringify(probabilities));
      assert.equal(d?.probabilities, undefined, JSON.stringify(probabilities));
    }
    const bare = decisionOf({ route: { type: "choice", choice: "opus_high" } });
    assert.equal(bare?.confidence, 0, "no confidence is not certainty");
  });

  test("a choice that is no offered pair gives no decision, so the caller falls back", () => {
    const offered = offeredTiers(new Set());
    for (const choice of ["haiku_max", "fable_high", "opus", "opus-high", "gpt_high", 3, undefined]) {
      assert.equal(decisionOf({ route: { type: "choice", choice } }, offered), null, String(choice));
    }
    assert.equal(
      decisionOf({ route: { type: "choice", choice: "haiku_medium" } }, offeredTiers(excludedTiers("haiku"))),
      null,
    );
    assert.equal(
      decisionOf({ route: { type: "choice", choice: "fable_high" } }, offeredTiers(new Set(), "hardest"))?.tier,
      "fable",
    );
  });

  test("a malformed route answer gives no decision, and is never read as the old questions", () => {
    for (const route of [null, "opus_high", { type: "score", score: 2 }, {}]) {
      assert.equal(decisionOf({ route, tier: { type: "choice", choice: "opus" } }), null, JSON.stringify(route));
      assert.equal(routeDecisionOf(route), null, JSON.stringify(route));
    }
  });

  test("an answer to the old two questions is still read as it was", () => {
    const old = jevOf({ haiku: 0.3, sonnet: 0.5, opus: 0.2 }, 3);
    assert.deepEqual(decisionOf(old, TIERS, DEFAULT_LADDER, 0.5), legacyDecisionOf(old, TIERS, DEFAULT_LADDER, 0.5));
    assert.equal(decisionOf(old, TIERS, DEFAULT_LADDER, 0.5)?.tier, "sonnet");
  });

  test("the pairs read are the ladder's: probability on a pair a narrowed band leaves out is dropped", () => {
    const ladder = ladderWith({ opusEffort: "high" });
    const d = decisionOf(routeOf({ opus_high: 0.4, opus_max: 0.6 }), TIERS, ladder, 0.5);
    assert.equal(d?.effort, "high");
    assert.equal(d?.probabilities?.opus_high, 1);
    assert.equal(decisionOf(routeOf({ opus_max: 1 }), TIERS, ladder), null);
  });
});

describe("pair decisions through the gate, the hold and storage", () => {
  const hardest = offeredTiers(new Set(), "hardest");

  test("under hardest a Fable family share at the bar runs on Fable at its likeliest effort", () => {
    const d = decisionOf(routeOf({ opus_high: 0.2, fable_high: 0.4, fable_max: 0.4 }), hardest, DEFAULT_LADDER, 0.5)!;
    assert.equal(d.tier, "fable");
    assert.equal(d.effort, "high");
    assert.ok(Math.abs(fableShareOf(d) - 0.8) < 1e-9);
    assert.equal(fableGate(d, "hardest", 0.75).tier, "fable");
  });

  test("under hardest a Fable family share under the bar is capped to Opus at the top of its band", () => {
    const d = decisionOf(routeOf({ opus_high: 0.3, fable_high: 0.35, fable_max: 0.35 }), hardest, DEFAULT_LADDER, 0.5)!;
    assert.equal(d.tier, "fable");
    const gated = fableGate(d, "hardest", 0.75);
    assert.equal(gated.tier, "opus");
    assert.equal(gated.effort, "max");
    assert.equal(gated.capped, "fable");
    assert.ok(Math.abs(gated.confidence - 0.3) < 1e-9, "the share behind Opus");
    assert.deepEqual(gated.probabilities, d.probabilities);
    const narrowed = ladderWith({ fable: "hardest", opusEffort: "medium-high" });
    assert.equal(fableGate(d, "hardest", 0.75, narrowed).effort, "high");
  });

  test("a kept family distribution still feeds the Fable bar", () => {
    const kept: Decision = { ...decisionFor("fable", 0.8), probabilities: { opus: 0.2, fable: 0.8 } };
    assert.equal(fableShareOf(kept), 0.8);
    assert.equal(fableGate(kept, "hardest", 0.75).tier, "fable");
  });

  test("stickiness holds a shaky move down on the family share", () => {
    const previous = decisionFor("opus", 1, "high");
    const shaky = decisionOf(routeOf({ sonnet_medium: 0.3, sonnet_high: 0.3, opus_high: 0.4 }), TIERS, DEFAULT_LADDER, 0.5)!;
    assert.equal(shaky.tier, "sonnet");
    const held = stickyDecision(shaky, previous, 0.75);
    assert.equal(held.tier, "opus");
    assert.equal(held.held, "sonnet");
    assert.equal(held.effort, "medium", "the effort Jev gave, clamped into Opus's band");
    assert.equal(held.confidence, 1, "the share behind the family that runs");

    const sure = decisionOf(routeOf({ sonnet_medium: 0.4, sonnet_high: 0.4, opus_high: 0.2 }), TIERS, DEFAULT_LADDER, 0.5)!;
    assert.equal(stickyDecision(sure, previous, 0.75).tier, "sonnet");
  });

  test("a pair decision comes back from storage as it was, either way it is read", () => {
    const fresh = decisionOf(routeOf({ sonnet_high: 0.39, sonnet_xhigh: 0.13, opus_high: 0.48 }), TIERS, DEFAULT_LADDER, 0.5)!;
    assert.ok(fresh.probabilities);
    const stored = JSON.parse(JSON.stringify(fresh));
    assert.deepEqual(revivedDecision(stored), fresh);
    assert.deepEqual(revivedDecision(stored, DEFAULT_LADDER, { clamp: false }), fresh);
  });

  test("every older shape still revives: family shares, no shares, rung names", () => {
    const tierShares = revivedDecision({ tier: "sonnet", effort: "high", confidence: 0.6, probabilities: { haiku: 0.4, sonnet: 0.2, opus: 0.4 } });
    assert.deepEqual(tierShares?.probabilities, { haiku: 0.4, sonnet: 0.2, opus: 0.4 });
    assert.ok(Math.abs(shareUpTo(tierShares!.probabilities!, "sonnet") - 0.6) < 1e-9);

    const bare = revivedDecision({ tier: "opus", effort: "high", confidence: 0.38 });
    assert.equal("probabilities" in (bare ?? {}), false);

    const rung = revivedDecision({ tier: "opus-max", confidence: 0.9, held: "sonnet-high" });
    assert.equal(rung?.tier, "opus");
    assert.equal(rung?.effort, "max");
    assert.equal(rung?.held, "sonnet");
  });

  test("a kept distribution with pair names reads only those, and junk is dropped", () => {
    const d = revivedDecision({
      tier: "opus",
      effort: "high",
      confidence: 1,
      probabilities: { opus_high: 0.5, opus_max: 0.5, opus: 1, gpt_high: 3 },
    });
    assert.deepEqual(d?.probabilities, { opus_high: 0.5, opus_max: 0.5 });
    for (const probabilities of [{ opus_high: 0 }, { opus_high: "1" }, { gpt_high: 1 }]) {
      const none = revivedDecision({ tier: "opus", confidence: 1, probabilities });
      assert.equal(none?.probabilities, undefined, JSON.stringify(probabilities));
    }
  });
});
