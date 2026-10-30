/**
 * The routing policy: which model families exist, how hard each may be
 * asked to think, what Jev is told each one is for, and how Jev's answer
 * becomes a model and an effort level.
 *
 * Jev answers one question, `route`: a Choice among the model·effort pairs
 * the ladder allows (`haiku_medium` … `opus_max`), each described as the
 * situation it is for (`pairCriteriaOf`). Jev makes the judgment; the
 * decision is made here, in code, family first (`pairPickOf`): the pair
 * probabilities are added up per family, the family is the cheapest one
 * enough of that backs, and the effort is the likeliest pair within it,
 * or, when the family holds less than half of Jev's probability, the
 * median effort of the whole answer, clamped into the family's band.
 * Nothing is gated on the answer's `confidence`, which TypeSafe defines as
 * how concentrated an answer is rather than how likely it is to be right.
 * Only pairs inside each family's band are offered, and the effort is
 * clamped into the band again on the way out, so a pairing the policy does
 * not offer can never run.
 *
 * It used to be two questions, a Choice of family and a Score of effort.
 * One Choice over pairs scored 88% against that design's 72% on 32
 * independently labelled cases: not significant (6 cases against 1, p
 * about 0.13), but its handling of Haiku work was plainly better, and one
 * question is one judgment rather than two answers that can disagree. The
 * same comparison is why the family comes first: a cumulative rule run
 * straight down a mixed list of pairs crosses from one family into the
 * next part-way through another's efforts, and fails both ways.
 * `legacyDecisionOf` still reads an answer to the old request, for
 * recorded answers and the evaluation harness.
 *
 * The ladder is built to save money. Opus at high effort is the default,
 * for most work and for any turn Jev could not route. The bands and the
 * default are settings (`ladderOf` builds them from what `config.ts`
 * read), since the mod is shared and how hard each model may think is a
 * matter of budget; what this file describes is what a new user gets.
 * Opus at max effort is
 * the ceiling unless the person has said otherwise: Fable sits on top of
 * the ladder, but how far up it a turn may go is their setting
 * (`FableMode`, read by `config.ts`). Under "never", the default, Fable is
 * not offered to Jev, is never a fallback, and `isForbiddenModel` clamps a
 * request for it whatever asked. Under "hardest", only a pick of Jev's with
 * enough of its probability on Fable itself runs on it (`fableGate`).
 * Under "open", it is an ordinary family, the top of the order.
 *
 * Nothing here touches the engine or the network, so it runs under plain
 * `node` in tests.
 */

import type { FableMode, LadderConfig } from "./config.ts";

export type { FableMode } from "./config.ts";

/**
 * One family on the ladder, ordered cheapest first in `TIERS`. Jev picks a
 * pair of a family and an effort; the family is read from the pair
 * probabilities first, and the effort is clamped into the family's band on
 * the ladder before anything runs.
 */
export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One option of the `route` question, a family at an effort, as Jev is
 * shown it: `opus_high`. The name describes the content, which a Choice
 * option's name should, since Jev reads it.
 */
export type Pair = `${Tier}_${Effort}`;

/**
 * Jev's probabilities as a decision keeps them: on pairs for a decision
 * made from the `route` question, on families for one kept before it, when
 * the family was asked on its own. Every reading of them that matters
 * (how much backs a family, how much is on Fable) goes through
 * `familySharesOf`, which treats the two alike.
 */
export type Shares = Partial<Record<Pair | Tier, number>>;

/**
 * The model family a decision runs on, for labels: `opus·high`. Since a
 * tier is a family now, the two are the same; the name is kept so callers
 * that ask for a family still read as asking for one.
 */
export type Family = Tier;

export type Decision = {
  tier: Tier;
  model: string;
  /** Always inside the tier's band on the ladder it was decided on. */
  effort: Effort;
  /**
   * How much of Jev's probability says this family is enough: P(family <=
   * this one), the pair probabilities added up per family over the pairs
   * offered, 0 to 1. 0 on a fallback.
   *
   * Not the answer's own `confidence`, which TypeSafe defines as how
   * concentrated the distribution is, not how likely the answer is to be
   * right: a 59/41 split between two Haiku pairs and a Sonnet pair has a
   * low confidence and still puts every last bit of its probability on
   * "Sonnet or cheaper will do". Only where Jev sent no probabilities (an
   * answer this file cannot read them from, or a decision kept before they
   * were read) is it that concentration instead, and then it is only
   * printed, never gated on.
   */
  confidence: number;
  /**
   * Jev's probability on each pair offered, renormalised over them, when
   * its answer carried any; on each family, for a decision kept from before
   * the pairs (`Shares`). Kept on the decision so the checks after the pick
   * (the Fable gate, at the step as well as at the turn, and the hold)
   * read the same distribution the pick was made from, rather than a
   * number standing in for it.
   */
  probabilities?: Shares;
  /**
   * Jev's confidence in the effort, on a decision made from the two
   * questions the `route` question replaced, which asked the effort on its
   * own. Only reported: no check reads it. A decision made from pairs has
   * none, since its effort came out of the same answer as its family.
   */
  effortConfidence?: number;
  /**
   * The tier Jev named, when stickiness kept the turn on the previous model
   * instead. Absent on a turn that went where Jev pointed. Kept so the route
   * line can say a hold happened; a hold nobody can see is indistinguishable
   * from a router that is not running.
   */
  held?: Tier;
  /**
   * The family of Jev's top pair, when the pick's family sits above it:
   * too little of Jev's probability said that family (or anything cheaper)
   * was enough, so the family rule (`pairPickOf`) moved the turn up to the
   * cheapest family that enough of it does back. Absent when the pick is on
   * the top pair's family or below it.
   */
  floored?: Tier;
  /**
   * The tier picked, when the person's Fable setting would not let it
   * run there and the turn went to Opus at the top of its band instead
   * (max, unless the person narrowed it): a Fable pick under "hardest"
   * with less of Jev's probability on Fable than the Fable bar, or one
   * under "never" (which should not happen, since Fable is not offered
   * then). Kept for the same reason as `held`: a cap nobody can see reads
   * as Jev aiming low.
   */
  capped?: Tier;
  /**
   * Why the default was used without Jev's pick: the provider failed,
   * timed out, or answered with no tier offered. Absent when Jev routed.
   * The turn still runs on a known pairing, so a dead provider costs the
   * ladder's default (Opus at high effort, unless the person set another),
   * never whatever the session happens to be set to.
   */
  fallback?: string;
};

/**
 * Cheapest first, ordered by what each can do: the order `pairPickOf` adds up
 * Jev's probability in, and what "above" and "below" mean everywhere.
 */
export const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];

/** Least thinking first. Index order is what "higher effort" means. */
export const EFFORTS: readonly Effort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Model ids as the engine names them. Change a model here and every
 * decision on that family follows.
 */
export const MODEL_OF_FAMILY: Record<Family, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

/** How hard one family may be asked to think, inclusive at both ends. */
export type Band = { min: Effort; max: Effort };

/**
 * How hard each family may be asked to think, unless the person has said
 * otherwise (`haikuEffort` and the rest, read by `config.ts`). This is the
 * edit point for what a new user gets: change a band here and every
 * decision on that family is clamped into the new one, Jev's answer
 * included, for everyone who has not set their own.
 *
 * No family runs at low. Low saves little on a model already cheap and is
 * where a quick answer turns into a wrong one; Haiku in particular is only
 * picked for work that cannot go wrong, and medium keeps it that way.
 * Haiku stops at high because a Haiku task that wants more thinking than
 * that was never a Haiku task: past high, the money is better spent on a
 * stronger model than on a weak one thinking longer.
 *
 * Sonnet, Opus and Fable run the whole range above low. Opus at high is
 * the default; its max is the ceiling while Fable is off, and is meant for
 * the clearly exceptional, which is what `THINKING` tells Jev.
 *
 * Every effort in a band is one option of the `route` question
 * (`offeredPairs`), so a band is also how many options Jev is shown: ten
 * with these.
 */
export const DEFAULT_BANDS: Readonly<Record<Tier, Readonly<Band>>> =
  Object.freeze({
    haiku: Object.freeze({ min: "medium", max: "high" }),
    sonnet: Object.freeze({ min: "medium", max: "max" }),
    opus: Object.freeze({ min: "medium", max: "max" }),
    fable: Object.freeze({ min: "medium", max: "max" }),
  });

/**
 * The default bands under the name they had while they were constants.
 *
 * @deprecated The bands are a setting now. Read a `Ladder`'s `bands` for
 * what a running router allows; `DEFAULT_BANDS` is only what it allows
 * when nobody set anything.
 */
export const EFFORT_RANGE: Readonly<Record<Tier, Readonly<Band>>> =
  DEFAULT_BANDS;

/**
 * The family for most work, and for every turn Jev could not route, unless
 * the person set another (`defaultModel`).
 */
export const DEFAULT_TIER: Tier = "opus";

/**
 * The effort for most work, and the one used when Jev gave none, unless
 * the person set another (`defaultEffort`).
 */
export const DEFAULT_EFFORT: Effort = "high";

/**
 * Where a Fable pick the person's setting refuses runs instead: Opus at
 * the top of its band, the top of the ladder while Fable is off. The
 * effort here is the default band's top; a router with its own bands reads
 * `ceilingOf(ladder)`, since a person who narrowed Opus to high has said
 * that is as hard as it thinks.
 */
export const CEILING_TIER: Tier = "opus";
export const CEILING_EFFORT: Effort = DEFAULT_BANDS[CEILING_TIER].max;

/** Whether a value names a family on the ladder. */
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as string[]).includes(value);
}

/** Whether a value names an effort level. */
export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as string[]).includes(value);
}

/** A family at an effort, as the `route` question names it: `opus_high`. */
export function pairName(tier: Tier, effort: Effort): Pair {
  return `${tier}_${effort}`;
}

/**
 * Every pair there is, cheapest family first and least thinking first
 * within it: the order options are shown in and shares are kept in.
 */
export const PAIRS: readonly Pair[] = TIERS.flatMap((tier) =>
  EFFORTS.map((effort) => pairName(tier, effort)),
);

/** Whether a value names a pair. */
export function isPair(value: unknown): value is Pair {
  return typeof value === "string" && (PAIRS as string[]).includes(value);
}

/** The family and effort a pair name says, or undefined when it is not one. */
export function pairOf(
  name: unknown,
): { tier: Tier; effort: Effort } | undefined {
  if (!isPair(name)) return undefined;
  const [tier, effort] = name.split("_") as [Tier, Effort];
  return { tier, effort };
}

/**
 * Every band there is, as a setting spells it: one level alone when the
 * band is a single level (`high`), else `min-max` (`medium-high`). Ordered
 * by where the band starts, then by how far it reaches, so a picker over
 * them reads low to high. Fifteen, since that is every pair with the
 * minimum at or below the maximum.
 */
export const BAND_NAMES: readonly string[] = EFFORTS.flatMap((min, i) =>
  EFFORTS.slice(i).map((max) => bandName({ min, max })),
);

/** A band as a setting spells it: `high` for high to high, else `min-max`. */
export function bandName(band: Band): string {
  return band.min === band.max ? band.min : `${band.min}-${band.max}`;
}

/**
 * The between-levels marks a band setting may use. The hyphen is what the
 * picker writes; the en dash is what `/jev` prints, so a band copied from
 * it into a shell profile still reads; `..` is how ranges are often typed.
 */
const BAND_SEPARATOR = /\s*(?:-|–|\.\.)\s*/;

/**
 * A band from a setting, or undefined when it is not one.
 *
 * One level is a band of that level alone (`high` is high to high); two,
 * joined by a hyphen, are the minimum and the maximum. Case and padding do
 * not matter. An inverted band (`max-medium`) is refused rather than
 * turned around: which end was the typo is a guess, and a refused value
 * falls through to the next source, which is the honest outcome.
 */
export function bandOf(raw: unknown): Band | undefined {
  if (typeof raw !== "string") return undefined;
  const parts = raw.trim().toLowerCase().split(BAND_SEPARATOR);
  if (parts.length < 1 || parts.length > 2) return undefined;
  const [min, max = min] = parts;
  if (!isEffort(min) || !isEffort(max)) return undefined;
  if (EFFORTS.indexOf(min) > EFFORTS.indexOf(max)) return undefined;
  return { min, max };
}

/**
 * The ladder a router runs on: how far each family may think, which family
 * is the default, and at what effort.
 *
 * The default is where every turn Jev could not route runs, what `/jev`
 * calls the default, and the one pair `pairCriteriaOf` tells Jev is the
 * catch-all for anything that fits nowhere else. What each family is for
 * is otherwise the same whoever runs the router.
 *
 * Built from the person's settings by `ladderOf`. Every policy function
 * that clamps or picks a default takes one, `DEFAULT_LADDER` when left
 * out, so a caller that predates the settings runs on what a new user gets.
 */
export type Ladder = {
  bands: Readonly<Record<Tier, Readonly<Band>>>;
  defaultTier: Tier;
  /** Always inside `bands[defaultTier]`. */
  defaultEffort: Effort;
  /**
   * The default model the setting named, when the person's Fable setting
   * would not let it be the default and `DEFAULT_TIER` stands in. Kept so
   * `/jev` can say so: a default nobody can see was refused reads as a
   * setting the router ignores.
   */
  refusedTier?: Tier;
  /**
   * The default effort the setting named, when it lay outside the default
   * model's band and `defaultEffort` is it clamped. Kept for the same
   * reason as `refusedTier`.
   */
  clampedEffort?: Effort;
};

/** What a new user runs on: the default bands, Opus at high effort. */
export const DEFAULT_LADDER: Ladder = Object.freeze({
  bands: DEFAULT_BANDS,
  defaultTier: DEFAULT_TIER,
  defaultEffort: DEFAULT_EFFORT,
});

/** `effort` moved into `band`. */
function clampInto(band: Readonly<Band>, effort: Effort): Effort {
  const i = EFFORTS.indexOf(effort);
  if (i < EFFORTS.indexOf(band.min)) return band.min;
  if (i > EFFORTS.indexOf(band.max)) return band.max;
  return effort;
}

/**
 * The ladder the person's settings describe.
 *
 * A band that cannot be read is the default band; `config.ts` already
 * refuses such values, so this only matters for a hand-built config. A
 * default model of Fable is only usable under "open": under "never" Fable
 * is above the ceiling, and under "hardest" only a pick of Jev's with
 * enough probability on Fable may run on it, which a fallback is not. Refused, the default is Opus and
 * the ladder says so in `refusedTier`. The default effort is then clamped
 * into whichever model is the default, and the ladder says so too.
 */
export function ladderOf(
  config: Readonly<LadderConfig & { fable: FableMode }>,
): Ladder {
  const named: Record<Tier, unknown> = {
    haiku: config.haikuEffort,
    sonnet: config.sonnetEffort,
    opus: config.opusEffort,
    fable: config.fableEffort,
  };
  const bands = {} as Record<Tier, Readonly<Band>>;
  for (const tier of TIERS) bands[tier] = bandOf(named[tier]) ?? DEFAULT_BANDS[tier];

  const asked = isTier(config.defaultModel) ? config.defaultModel : DEFAULT_TIER;
  const refused = asked === "fable" && config.fable !== "open";
  const defaultTier = refused ? DEFAULT_TIER : asked;

  const wanted = isEffort(config.defaultEffort)
    ? config.defaultEffort
    : DEFAULT_EFFORT;
  const defaultEffort = clampInto(bands[defaultTier], wanted);

  return {
    bands,
    defaultTier,
    defaultEffort,
    ...(refused ? { refusedTier: asked } : {}),
    ...(defaultEffort !== wanted ? { clampedEffort: wanted } : {}),
  };
}

/**
 * Where a refused Fable pick runs on this ladder: Opus at the top of its
 * band. Opus at max by default; a person who narrowed Opus's band has said
 * how hard it may think, the cap included.
 */
export function ceilingOf(ladder: Ladder = DEFAULT_LADDER): {
  tier: Tier;
  effort: Effort;
} {
  return { tier: CEILING_TIER, effort: ladder.bands[CEILING_TIER].max };
}

/**
 * `effort` moved into the family's band on the ladder: up to its minimum
 * when below it, down to its maximum when above it, untouched inside it.
 */
export function clampEffort(
  tier: Tier,
  effort: Effort,
  ladder: Ladder = DEFAULT_LADDER,
): Effort {
  return clampInto(ladder.bands[tier], effort);
}

/** The model a family runs on. */
export function modelOf(tier: Tier): string {
  return MODEL_OF_FAMILY[tier];
}

/** The family a decision's model belongs to, for labels. */
export function familyOf(tier: Tier): Family {
  return tier;
}

/**
 * What each family ran on when every tier was a fixed rung, at the effort
 * a decision on it gets when Jev gives none.
 *
 * @deprecated A family no longer has one effort. Read a ladder's `bands`
 * for what it allows, its `defaultEffort` (clamped with `clampEffort`) for
 * what it gets by default, and a decision's own `effort` for what it runs
 * at. These are the default ladder's, whatever the person set.
 */
export const RUNGS: Record<Tier, { family: Family; effort: Effort }> = {
  haiku: { family: "haiku", effort: clampEffort("haiku", DEFAULT_EFFORT) },
  sonnet: { family: "sonnet", effort: clampEffort("sonnet", DEFAULT_EFFORT) },
  opus: { family: "opus", effort: clampEffort("opus", DEFAULT_EFFORT) },
  fable: { family: "fable", effort: clampEffort("fable", DEFAULT_EFFORT) },
};

/**
 * What the effort Score of the two-question request was told each level is
 * for, least thinking first, in `EFFORTS` order: that score was an index
 * into this list.
 *
 * @deprecated Jev is no longer asked the effort on its own; each pair's
 * criterion says how much thinking it is for (`THINKING`). Kept with
 * `effortOf`, `effortScoreOf` and `levelSharesOf` so an answer to the old
 * request still reads (`legacyDecisionOf`) and the evaluation harness can
 * show what the previous design was asked.
 */
export const EFFORT_CRITERIA: readonly string[] = [
  "No thinking needed. The answer is immediate.",
  "A little thinking. A step or two, with the approach plain from the start.",
  "Ordinary real work, where most tasks belong. Several steps, a few " +
    "files, or a choice worth weighing: everyday implementation, planning, " +
    "review, research or debugging.",
  "Harder than ordinary. Many interacting parts, or a subtle failure to " +
    "chase down, where careful extra thought clearly pays for itself.",
  "Only for clearly exceptional, high-stakes work: a novel design with no " +
    "precedent to follow, a failure that has already resisted ordinary " +
    "debugging, or a decision that is costly to get wrong and hard to " +
    "undo. Hard but ordinary work is not this.",
];

/**
 * Jev's score across `EFFORT_CRITERIA` to the nearest effort level, held
 * to the scale's ends. A score that is not a finite number reads as
 * `fallback`, the default effort unless the caller's ladder has another:
 * no answer is no reason to think less.
 */
export function effortOf(
  score: unknown,
  fallback: Effort = DEFAULT_EFFORT,
): Effort {
  if (typeof score !== "number" || !Number.isFinite(score)) return fallback;
  const i = Math.min(Math.max(Math.round(score), 0), EFFORTS.length - 1);
  return EFFORTS[i] ?? fallback;
}

/**
 * The level probabilities of a Score answer, in level order, renormalised,
 * or undefined when there are none to read.
 *
 * TypeSafe keys them by level number as a string (`"0"` to `"4"`), so that
 * is what is read; an array in level order is read too, since nothing is
 * lost by it. A level missing, negative or not a number counts as 0, and a
 * set that adds up to nothing is no set.
 */
export function levelSharesOf(
  raw: unknown,
  levels: number = EFFORTS.length,
): number[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const at = (i: number): number => {
    const v = Array.isArray(raw)
      ? (raw as unknown[])[i]
      : (raw as Record<string, unknown>)[String(i)];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const shares = Array.from({ length: levels }, (_, i) => at(i));
  const total = shares.reduce((a, b) => a + b, 0);
  return total > 0 ? shares.map((p) => p / total) : undefined;
}

/**
 * Where an effort answer sits on `EFFORT_CRITERIA`: the Score's own
 * position (`score`), which is the documented answer and the probability-
 * weighted mean of the levels. Only when that is missing is the same mean
 * worked out here from the level probabilities. Neither is gated on the
 * answer's `confidence`: a shaky effort inside the family's band costs at
 * most a step of thinking, never the wrong model.
 */
export function effortScoreOf(answer: unknown): number | undefined {
  if (!isRecord(answer) || answer.type !== "score") return undefined;
  const score = finite(answer.score);
  if (score !== undefined) return score;
  const shares = levelSharesOf(answer.probabilities);
  return shares?.reduce((sum, p, i) => sum + p * i, 0);
}

/**
 * The families below Opus, which read the same whatever the person's Fable
 * setting is.
 *
 * The bar for leaving Opus rises the cheaper the family: Jev should only
 * go down to Haiku for work no model could get wrong, and down to Sonnet
 * only for implementation simple enough that nothing in it is hard to
 * decide. How hard either thinks is the second half of each pair's
 * criterion (`THINKING`), not this line's business.
 */
const BELOW_OPUS: Record<"haiku" | "sonnet", string> = {
  haiku:
    "Trivial beyond doubt, the kind of task no language model could get " +
    "wrong. Answering a yes or no from text already given, a lookup of one " +
    "named value, restating or reformatting something already on screen, a " +
    "single rename with no decision in it. If there is any doubt at all, " +
    "this is not Haiku work.",
  sonnet:
    "Simple implementation, from really simple to relatively simple, with " +
    "nothing hard to decide. A small edit whose shape the request already " +
    "spells out, a small function, a straightforward test, wiring an " +
    "existing piece into another, a mechanical search that lists results, " +
    "a focused read-and-summarize of known files. The approach is obvious " +
    "and little could go wrong.",
};

/**
 * Haiku when the person made one of its pairs the default. "Any doubt
 * rules it out" and "anything unclear lands here" cannot both be true, and
 * the person has said which one they want, so the doubt clause goes; the
 * examples stay, since they still say what Haiku is good at.
 */
const HAIKU_DEFAULT =
  "Quick work with little in it to decide. Answering a yes or no from " +
  "text already given, a lookup of one named value, restating or " +
  "reformatting something already on screen, a single rename.";

/**
 * Opus while it tops the ladder ("never" and "hardest"): the work with
 * real substance, planning, research, review and verification included,
 * since an earlier cut gave all of that to a rung above the default and
 * sent most of a fan-out of planners and reviewers there.
 *
 * It no longer says it is the default, nor that it owns the exceptional
 * hard cases. The default is one pair's to say (`DEFAULT_PAIR_CLAUSE`), and
 * a family line that said it too was the double pull toward the default
 * the comparison found. The exceptional cases are what `opus_max` is for,
 * and that is the effort half's to say: on `opus_medium` a line claiming
 * them would contradict "a little thinking".
 */
const OPUS_TOP =
  "Work with real substance: implementation carrying real complexity, " +
  "changes across several files, debugging, planning and research, code " +
  "review, verifying work already done, investigating an unfamiliar " +
  "codebase.";

/**
 * Opus under "open", where Fable takes the work in which finding the
 * approach is the hard part. Opus keeps every kind of implementation, the
 * hard kind included, plus review and verification, which judge work
 * already shaped rather than shape it.
 */
const OPUS_OPEN =
  "Implementation of any size, including hard implementation where the " +
  "approach is settled but a subtle mistake would be expensive, changes " +
  "across several files, debugging a known failure, code review, verifying " +
  "work already done.";

/**
 * Fable per setting. Under "never" it is never offered, so its line is
 * only there to keep the record total; under "hardest" it is the few tasks
 * even Opus at max would likely fail; under "open" it is the original
 * router's Fable tier, the work where finding the approach is the hard
 * part.
 */
const FABLE_CRITERIA: Record<FableMode, string> = {
  never: "Not offered: Fable is turned off for this router.",
  hardest:
    "Only the exceptional few where even Opus at max effort would likely " +
    "fall short: problems at the edge of what any model can do, where the " +
    "strongest reasoning available is worth its much higher cost. If Opus " +
    "at max effort would probably manage, this is not Fable work.",
  open:
    "High complexity needing higher-order reasoning. Planning, " +
    "brainstorming, architecture, systematic debugging, weighing " +
    "trade-offs, research. Anything where working out the approach is " +
    "itself the hard part.",
};

/**
 * The kind of work each family is for, under one Fable setting and one
 * ladder: the first half of every pair's criterion. This table and
 * `THINKING` are the policy: edit these lines to change where work goes,
 * `THINKING` to change how hard it thinks there, and `DEFAULT_BANDS` to
 * change how far each family may go for anyone who has not set their own
 * bands.
 *
 * No line says which family is the default. That is said once, on the
 * default pair (`pairCriteriaOf`). The ladder only matters for Haiku: a
 * person who made a Haiku pair the default has asked for unclear work to
 * land there, which the "any doubt" clause would forbid, so it goes.
 */
export function criteriaOf(
  fable: FableMode,
  ladder: Ladder = DEFAULT_LADDER,
): Record<Tier, string> {
  return {
    haiku: ladder.defaultTier === "haiku" ? HAIKU_DEFAULT : BELOW_OPUS.haiku,
    sonnet: BELOW_OPUS.sonnet,
    opus: fable === "open" ? OPUS_OPEN : OPUS_TOP,
    fable: FABLE_CRITERIA[fable],
  };
}

/**
 * What a family's kind of work is, for choosing which effort lines its
 * pairs get. Haiku and Sonnet are simple by their own definition; Opus and
 * Fable are for work with something in it to work out.
 */
export type WorkKind = "simple" | "demanding";

export const WORK_KIND: Readonly<Record<Tier, WorkKind>> = Object.freeze({
  haiku: "simple",
  sonnet: "simple",
  opus: "demanding",
  fable: "demanding",
});

/**
 * How much thinking each effort is for, the second half of every pair's
 * criterion, per kind of work, least thinking first.
 *
 * Two columns, because the same level means a different situation on a
 * family whose work is simple. "Nothing hard to decide, but think as hard
 * as possible" is a contradiction, and wording like it is what pulled
 * ordinary work off Opus onto `sonnet_xhigh` and `sonnet_max` in the
 * comparison. On simple work, more thinking is for work that is long, or
 * where a slip is costly to undo, never for work that is hard to decide.
 *
 * On demanding work, high is ordinary real work and max the clearly
 * exceptional, because that is the split the money depends on: a max that
 * reads as merely "hard" pulls every planner and reviewer in a fan-out up
 * to it. Neither column says where most work belongs; that is the default
 * pair's one sentence (`DEFAULT_PAIR_CLAUSE`), and a second would double
 * the pull. Low is written too, for a person who widens a band down to it;
 * by default no band includes it, so it is never shown.
 *
 * Each line describes its level against its neighbours, so it is sent as
 * written only where the band offers them; a narrowed band and the default
 * pair read it through `thinkingOf`.
 */
export const THINKING: Readonly<
  Record<WorkKind, Readonly<Record<Effort, string>>>
> = Object.freeze({
  simple: Object.freeze({
    low: "Nothing to work out: the answer is immediate.",
    medium: "Short: a step or two, with the approach plain from the start.",
    high: "Several plain steps, or a few files to get through.",
    xhigh: "Simple work that is long or has many parts to keep straight.",
    max: "Simple work where a slip would be costly to undo.",
  }),
  demanding: Object.freeze({
    low: "Already worked out: what to do is known and only needs doing.",
    medium: "A little thinking: a step or two once the work is understood.",
    high:
      "Ordinary real work: several steps, a few files, or a choice worth " +
      "weighing.",
    xhigh:
      "Harder than ordinary: many interacting parts, or a subtle failure to " +
      "chase down, where careful extra thought clearly pays for itself.",
    max:
      "Clearly exceptional and high-stakes: a novel design with no precedent " +
      "to follow, a failure that has already resisted ordinary debugging, or " +
      "a decision that is costly to get wrong and hard to undo. Hard but " +
      "ordinary work is not this.",
  }),
});

/**
 * The `THINKING` lines that rule lighter work out, without that part: what
 * a pair says when it must take the lighter work in after all. Only two
 * lines have such a part ("Harder than ordinary", "Hard but ordinary work
 * is not this"); every other line has nothing to drop and reads as it is.
 *
 * They are for two pairs. The default pair is the catch-all, and "anything
 * that does not clearly fit another option belongs here" beside "ordinary
 * work is not this" is a contradiction, the same one `HAIKU_DEFAULT` takes
 * the doubt clause out of Haiku's line for. And the lowest pair of a band
 * that starts above medium is all its family has for lighter work
 * (`thinkingOf`).
 */
const THINKING_UNFENCED: Readonly<
  Partial<Record<WorkKind, Readonly<Partial<Record<Effort, string>>>>>
> = Object.freeze({
  demanding: Object.freeze({
    xhigh:
      "Careful extra thought: many interacting parts, or a subtle failure " +
      "to chase down, where it clearly pays for itself.",
    max:
      "High-stakes: a novel design with no precedent to follow, a failure " +
      "that has already resisted ordinary debugging, or a decision that is " +
      "costly to get wrong and hard to undo.",
  }),
});

/**
 * What the lowest pair of a band that starts above medium adds: that its
 * family's lighter work is its too, since the band has nowhere lighter.
 */
export const LIGHTER_TOO = "Work needing less thought belongs here too.";

/**
 * How much thinking one pair's criterion says it is for, on its band, or
 * undefined when it should say nothing about it.
 *
 * `THINKING` describes each level against its neighbours, which is right
 * when the neighbours are offered and wrong when the person's band left
 * them out. Read against a narrowed band, the same lines told Jev that the
 * family's only option was not for ordinary work (`opus_max` alone) or not
 * for one-step work (`haiku_high` alone), so that work fitted no option of
 * a family that should take it, and its probability spread to the next
 * family over, which is the drift the pair Choice was built to stop. So:
 *
 *   - a band of one level says nothing of thinking: the family's line is
 *     the whole situation, since every task the family takes runs there;
 *   - the lowest level of a band that starts above medium takes the
 *     family's lighter work in (`LIGHTER_TOO`), its fence dropped. Medium
 *     needs no such help: its line ("a step or two") already reads as
 *     covering an answer that needs no thought, which is all "low" adds;
 *   - the default pair drops its fence as well (`THINKING_UNFENCED`).
 *
 * The top of a band is left as it is. What a band's top cannot hold is
 * heavier work, and heavier work has a family above it to go to, or, on
 * the family at the top, nowhere better among the options: the drift that
 * costs is downward.
 */
export function thinkingOf(
  tier: Tier,
  effort: Effort,
  band: Readonly<Band>,
  isDefault: boolean,
): string | undefined {
  if (band.min === band.max) return undefined;
  const kind = WORK_KIND[tier];
  const floor =
    effort === band.min &&
    EFFORTS.indexOf(band.min) > EFFORTS.indexOf("medium");
  const line =
    floor || isDefault
      ? (THINKING_UNFENCED[kind]?.[effort] ?? THINKING[kind][effort])
      : THINKING[kind][effort];
  return floor ? `${line} ${LIGHTER_TOO}` : line;
}

/**
 * The one sentence that makes the ladder's default pair the catch-all,
 * said on that pair alone. A person who made Sonnet the default has asked
 * for unclear work to land there, and a default that only moved fallbacks
 * while Jev kept sending everything ambiguous to Opus would be a setting in
 * name only.
 */
export const DEFAULT_PAIR_CLAUSE =
  "The default: anything that does not clearly fit another option belongs " +
  "here.";

/**
 * The pairs the `route` question offers on a ladder: for each offered
 * family, cheapest first, every effort in its band, least thinking first.
 * This does not drop Fable; `pairCriteriaOf` does, under "never", and
 * `offeredTiers` already leaves it out there.
 */
export function offeredPairs(
  offered: readonly Tier[],
  ladder: Ladder = DEFAULT_LADDER,
): Pair[] {
  return TIERS.filter((t) => offered.includes(t)).flatMap((tier) => {
    const band = ladder.bands[tier];
    return EFFORTS.slice(
      EFFORTS.indexOf(band.min),
      EFFORTS.indexOf(band.max) + 1,
    ).map((effort) => pairName(tier, effort));
  });
}

/** The ladder's default pair: its default family at its default effort. */
export function defaultPairOf(ladder: Ladder = DEFAULT_LADDER): Pair {
  return pairName(ladder.defaultTier, ladder.defaultEffort);
}

/**
 * Each offered pair's criterion, in `offeredPairs` order: the family's
 * kind of work (`criteriaOf`), then how much thinking the effort is for on
 * that kind of work, read against the family's band (`thinkingOf`), then,
 * on the default pair alone, `DEFAULT_PAIR_CLAUSE`. Each reads as a
 * situation on its own, since Jev weighs options side by side and none can
 * lean on another's wording.
 *
 * Under "never" Fable is dropped even if a caller offered it, so a stray
 * offer cannot reach Jev with a line that says it is not offered.
 */
export function pairCriteriaOf(
  offered: readonly Tier[],
  fable: FableMode = "never",
  ladder: Ladder = DEFAULT_LADDER,
): Partial<Record<Pair, string>> {
  const work = criteriaOf(fable, ladder);
  const home = defaultPairOf(ladder);
  const shown =
    fable === "never" ? offered.filter((t) => t !== "fable") : offered;
  const criteria: Partial<Record<Pair, string>> = {};
  for (const pair of offeredPairs(shown, ladder)) {
    const { tier, effort } = pairOf(pair)!;
    const isDefault = pair === home;
    const thinking = thinkingOf(tier, effort, ladder.bands[tier], isDefault);
    const parts = thinking === undefined ? [work[tier]] : [work[tier], thinking];
    if (isDefault) parts.push(DEFAULT_PAIR_CLAUSE);
    criteria[pair] = parts.join(" ");
  }
  return criteria;
}

/**
 * The criteria under the default setting, "never". Kept for callers that
 * predate the setting; new code asks `criteriaOf(mode)`.
 */
export const TIER_CRITERIA: Record<Tier, string> = criteriaOf("never");

/**
 * The pattern for a Fable model. Loose so a dated id or an alias
 * (`claude-fable-5-1-20260901`, `fable`, a Bedrock id) is caught as well.
 */
const FABLE_MODEL = /fable/i;

/**
 * Whether a model id or alias may not run as asked, under a Fable setting.
 *
 * This is the guard for requests the router did not choose: a session set
 * to a model, a script's `agent({ model })`. Under "never" Fable is above
 * the ceiling. Under "hardest" it is still refused here, because only
 * Jev's own pick, through `fableGate`, may run on it; a script asking for
 * Fable by name is exactly the bill the setting exists to stop. Under
 * "open" nothing is refused.
 */
export function isForbiddenModel(
  model: string | undefined,
  fable: FableMode = "never",
): boolean {
  if (fable === "open") return false;
  return typeof model === "string" && FABLE_MODEL.test(model);
}

/**
 * Each family's model, as loosely as `FABLE_MODEL`: an alias (`haiku`), a
 * dated id, a Bedrock id, a `[1m]` suffix all name the family they say.
 */
const FAMILY_MODEL: Readonly<Record<Tier, RegExp>> = {
  haiku: /haiku/i,
  sonnet: /sonnet/i,
  opus: /opus/i,
  fable: FABLE_MODEL,
};

/**
 * The family a model id or alias belongs to, or undefined for one the
 * ladder does not know (another vendor's, a model newer than this file).
 *
 * This is how a request the router did not decide is still held to the
 * bands: a fork, a resume, a step the engine moved to a fallback model all
 * name a model, and the model says which band its effort belongs in.
 */
export function familyOfModel(model: string | undefined): Tier | undefined {
  if (typeof model !== "string") return undefined;
  return TIERS.find((tier) => FAMILY_MODEL[tier].test(model));
}

/**
 * Where a Fable request the setting refuses runs, when nobody routed it: a
 * session set to Fable, a fork of one, a script's `agent({ model })` with
 * subagent routing off.
 *
 * The ladder's default, lifted to Opus when it sits below. Someone asked
 * for the strongest model by name, which says the work is at least Opus
 * work; a router defaulting to Haiku that answered that request with
 * Haiku would turn the person's "this is hard" into the weakest model on
 * the ladder, below where a refused Fable pick of Jev's goes. The effort
 * stays the default's, clamped into Opus's band, rather than the ceiling's
 * that `fableGate` gives Jev's own refused pick: a name in a script is not
 * Jev judging the task exceptional, and a workflow that pins forty agents
 * to Fable should not get forty runs at max for it. With a new user's
 * ladder this is the default itself, Opus at high.
 *
 * The default is never Fable where anything is refused: only "open" lets
 * Fable be the default, and "open" refuses nothing.
 */
export function guardTargetOf(ladder: Ladder = DEFAULT_LADDER): {
  tier: Tier;
  effort: Effort;
} {
  const tier =
    TIERS.indexOf(ladder.defaultTier) >= TIERS.indexOf(CEILING_TIER)
      ? ladder.defaultTier
      : CEILING_TIER;
  return { tier, effort: clampEffort(tier, ladder.defaultEffort, ladder) };
}

/**
 * Tiers dropped from the question entirely, lowercase, from the env var.
 *
 * Only family names count. The rung names of the fixed ladder this
 * replaced (`sonnet-medium`, `opus-high` and the rest) are ignored rather
 * than guessed at: dropping all of Sonnet because one of its old rungs was
 * named would take away more than was asked.
 *
 * Two families are never excluded. The ladder's default, since it is where
 * every fallback goes, and a default Jev may not pick is
 * a router that can only reach it by failing. And Opus, whatever the
 * default, since it is where a refused Fable pick is capped to, and the
 * one family whose criteria cover anything that fits nowhere else.
 */
export function excludedTiers(
  raw: string | undefined,
  ladder: Ladder = DEFAULT_LADDER,
): Set<Tier> {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    names.filter(isTier).filter((t) => !isKept(t, ladder)),
  );
}

/** Whether a family stays on offer whatever the exclusions say. */
function isKept(tier: Tier, ladder: Ladder): boolean {
  return tier === ladder.defaultTier || tier === CEILING_TIER;
}

/**
 * The tiers offered to Jev, in ladder order, never empty, and never
 * without Opus or the ladder's default (see `excludedTiers`). Fable is not
 * offered at all under "never", so excluding everything else still cannot
 * put it on the table.
 */
export function offeredTiers(
  excluded: Set<Tier>,
  fable: FableMode = "never",
  ladder: Ladder = DEFAULT_LADDER,
): Tier[] {
  const tiers = fable === "never" ? TIERS.filter((t) => t !== "fable") : TIERS;
  return tiers.filter((t) => isKept(t, ladder) || !excluded.has(t));
}

type ChoiceAnswer = {
  type: "choice";
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
};
type ScoreAnswer = { type: "score"; score?: unknown; confidence?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Slack for adding probabilities up: 0.59 + 0.41 is 0.9999999999999999 in
 * floating point, and a bar of 1 has to be reachable by a tier that holds
 * every last bit of what is left.
 */
const SUM_SLACK = 1e-9;

/**
 * Jev's probability on each offered tier, renormalised over them, every
 * offered tier present (0 when Jev gave it none), or undefined when there
 * is nothing to read: not an object, or no probability on any offered
 * tier.
 *
 * Probability on a tier that was not offered is dropped rather than read
 * as a vote for its neighbour: Jev was not shown it, so it should carry
 * none, and if it does the rest still says how the offered tiers compare.
 * A value that is negative or not a number counts as 0.
 */
export function tierSharesOf(
  raw: unknown,
  offered: readonly Tier[] = TIERS,
): Partial<Record<Tier, number>> | undefined {
  if (!isRecord(raw) || Array.isArray(raw)) return undefined;
  const tiers = TIERS.filter((t) => offered.includes(t));
  const read = (t: Tier) => {
    const v = finite(raw[t]);
    return v !== undefined && v > 0 ? v : 0;
  };
  const total = tiers.reduce((sum, t) => sum + read(t), 0);
  if (!(total > 0)) return undefined;
  // A set that already adds up to 1 is left exactly as sent, so a decision
  // stored and read back compares equal to itself.
  const scale = Math.abs(total - 1) <= SUM_SLACK ? 1 : total;
  const shares: Partial<Record<Tier, number>> = {};
  for (const t of tiers) shares[t] = read(t) / scale;
  return shares;
}

/**
 * A distribution added up per family: each pair's share goes to its
 * family, and a family's own share (a decision kept from before the pairs)
 * is its family's already. Only families the shares mention are present,
 * so the families offered are all there when the shares hold every offered
 * pair, as `pairSharesOf` makes them. Anything else is ignored.
 */
export function familySharesOf(
  shares: Readonly<Shares>,
): Partial<Record<Tier, number>> {
  const families: Partial<Record<Tier, number>> = {};
  for (const [name, p] of Object.entries(shares)) {
    const tier = isTier(name) ? name : pairOf(name)?.tier;
    if (tier === undefined || typeof p !== "number") continue;
    families[tier] = (families[tier] ?? 0) + p;
  }
  const ordered: Partial<Record<Tier, number>> = {};
  for (const t of TIERS) if (t in families) ordered[t] = families[t];
  return ordered;
}

/**
 * How much of a distribution says `tier` or something cheaper is enough:
 * P(family <= `tier`), adding up the family shares (`familySharesOf`) in
 * ladder order, so a pair distribution and a kept family one read alike.
 * A family the shares do not hold adds nothing.
 */
export function shareUpTo(shares: Readonly<Shares>, tier: Tier): number {
  const families = familySharesOf(shares);
  const sum = TIERS.slice(0, TIERS.indexOf(tier) + 1).reduce(
    (s, t) => s + (families[t] ?? 0),
    0,
  );
  return Math.min(1, sum);
}

/** What `tierOf` makes of a distribution. */
export type TierPick = {
  /** The tier the turn runs on, before the Fable gate. */
  tier: Tier;
  /** Jev's top choice: the tier holding the most probability. */
  top: Tier;
  /** P(tier <= `tier`): how much of Jev's probability backs the pick. */
  cumulative: number;
  /** The distribution read, renormalised over the offered tiers. */
  shares: Partial<Record<Tier, number>>;
};

/**
 * The tier a distribution over the offered tiers comes to, or undefined
 * when there is none to read (`tierSharesOf`).
 *
 * The family rule of the two-question request, read by `legacyDecisionOf`;
 * `pairPickOf` applies the same rule to the family sums of a `route`
 * answer.
 *
 * The tiers are ordered by what they can do, Haiku below Sonnet below Opus
 * below Fable (when Fable is offered at all), so Jev's probabilities say
 * more than which tier comes top: added up from the cheapest, they say how
 * likely it is that a tier or something cheaper is enough. The pick is the
 * cheapest offered tier where that reaches `minConfidence`. At 0.5 it is
 * the median of Jev's distribution: the tier where at least half of Jev's
 * belief says "this, or cheaper, will do", and the rest says nothing
 * cheaper would.
 *
 * Why not the top choice and its `confidence`, which is what this used to
 * read: TypeSafe's `confidence` is how concentrated the distribution is,
 * not how likely the answer is to be right, and on an ordered scale it
 * gates the wrong thing. A one-constant edit Jev split 59/41 between Haiku
 * and Sonnet, with nothing on Opus, has a confidence of 0.38; a floor on
 * that sent it to Opus at high, the one tier Jev had ruled out. Read as a
 * cumulative share, the same answer is Haiku at 59% (or Sonnet, with all of
 * it, under a bar of 0.6), and the 52% Jev put on Opus for a search it
 * split with Sonnet puts that on Opus.
 *
 * `minConfidence` of 0 (or less) turns the rule off and takes Jev's top
 * choice, rather than the cheapest tier with any probability, which is
 * what a cumulative bar of 0 would literally say. Ties for the top go to
 * `choice` when it is among them (Jev's own pick), else to the cheapest.
 */
export function tierOf(
  probabilities: unknown,
  offered: readonly Tier[] = TIERS,
  minConfidence: number = DEFAULT_CONFIDENCE_FLOOR,
  choice?: unknown,
): TierPick | undefined {
  const shares = tierSharesOf(probabilities, offered);
  if (shares === undefined) return undefined;
  const tiers = TIERS.filter((t) => t in shares);

  const most = Math.max(...tiers.map((t) => shares[t] ?? 0));
  const tops = tiers.filter((t) => (shares[t] ?? 0) >= most - SUM_SLACK);
  const top = isTier(choice) && tops.includes(choice) ? choice : tops[0]!;

  const tier =
    minConfidence > 0
      ? (tiers.find((t) => shareUpTo(shares, t) >= minConfidence - SUM_SLACK) ??
        tiers[tiers.length - 1]!)
      : top;
  return { tier, top, cumulative: shareUpTo(shares, tier), shares };
}

/**
 * The decision for a family, at a given confidence and effort. The effort
 * is clamped into the family's band on the ladder, so no caller can build
 * a pairing the policy does not offer; left out (or undefined), it is the
 * ladder's default effort, clamped.
 */
export function decisionFor(
  tier: Tier,
  confidence: number,
  effort?: Effort,
  ladder: Ladder = DEFAULT_LADDER,
): Decision {
  return {
    tier,
    model: modelOf(tier),
    effort: clampEffort(tier, effort ?? ladder.defaultEffort, ladder),
    confidence,
  };
}

/**
 * The ladder's default, Opus at high effort unless the person set another,
 * used because Jev's answer could not be.
 */
export function fallbackDecision(
  reason: string,
  ladder: Ladder = DEFAULT_LADDER,
): Decision {
  return {
    ...decisionFor(ladder.defaultTier, 0, ladder.defaultEffort, ladder),
    fallback: reason,
  };
}

/**
 * Jev's probability on each offered pair, renormalised over them, every
 * offered pair present (0 when Jev gave it none) in `PAIRS` order, or
 * undefined when there is nothing to read: not an object, or no
 * probability on any offered pair.
 *
 * As with families (`tierSharesOf`), probability on a pair that was not
 * offered is dropped rather than read as a vote for its neighbour, and a
 * value that is negative or not a number counts as 0. A set that already
 * adds up to 1 is left exactly as sent, so a decision stored and read back
 * compares equal to itself.
 */
export function pairSharesOf(
  raw: unknown,
  offered: readonly Pair[],
): Partial<Record<Pair, number>> | undefined {
  if (!isRecord(raw) || Array.isArray(raw)) return undefined;
  const pairs = PAIRS.filter((p) => offered.includes(p));
  const read = (p: Pair) => {
    const v = finite(raw[p]);
    return v !== undefined && v > 0 ? v : 0;
  };
  const total = pairs.reduce((sum, p) => sum + read(p), 0);
  if (!(total > 0)) return undefined;
  const scale = Math.abs(total - 1) <= SUM_SLACK ? 1 : total;
  const shares: Partial<Record<Pair, number>> = {};
  for (const p of pairs) shares[p] = read(p) / scale;
  return shares;
}

/** What `pairPickOf` makes of a distribution over pairs. */
export type PairPick = {
  /** The family the turn runs on, before the Fable gate. */
  tier: Tier;
  /**
   * The effort: the likeliest pair within the family when the family holds
   * a majority of the probability, else the median effort of the whole
   * distribution, clamped into the family's band.
   */
  effort: Effort;
  /** Jev's top pair: the one holding the most probability of all. */
  top: Pair;
  /** P(family <= `tier`): how much of Jev's probability backs the family. */
  cumulative: number;
  /** The distribution read, renormalised over the offered pairs. */
  shares: Partial<Record<Pair, number>>;
};

/**
 * The family and effort a distribution over the offered pairs comes to,
 * or undefined when there is none to read (`pairSharesOf`). Family first,
 * then effort.
 *
 * The family. Each family's share is the sum of its pairs' (`familySharesOf`),
 * and the families are ordered by what they can do, so, added up from the
 * cheapest, they say how likely it is that a family or something cheaper
 * is enough. The family is the cheapest offered one where that reaches
 * `minConfidence`: at 0.5, the median of Jev's belief over families, as
 * before the pairs. `minConfidence` of 0 (or less) takes the family with
 * the most probability instead, ties to the family of Jev's own `choice`
 * when it is among them, else to the cheapest.
 *
 * The effort. When the family holds a majority of Jev's probability
 * (`FAMILY_MAJORITY`, half), the likeliest pair within it, ties to the
 * lower effort: Jev's pick of how hard, given the model. When it holds
 * less, its own pairs are a minority's ranking, and the effort comes from
 * the whole answer instead (`spreadEffortOf`): the median effort level
 * across every offered pair, each weighed by its share, clamped into the
 * family's band. A bare "ship it" split haiku .47, sonnet .20, opus .33
 * reaches half on Sonnet, where `sonnet_max` held .07 and topped the
 * family; read within Sonnet alone, that ran Sonnet at max on a hunch of
 * 7%, while most of Jev's belief said medium or high.
 *
 * Why the majority, and why the median: the bar is the same "most of what
 * Jev believes" that the family rule's default `minConfidence` is, not a
 * number fitted to that case; and the efforts, unlike the families across
 * pairs, are ordered within the answer as a whole, so their median is the
 * effort at least half of Jev's belief says is enough, whatever model it
 * had in mind. That is a judgment of how hard the request is, and the
 * models' bands only say how far each may go with it.
 *
 * Why family first: a cumulative rule run straight down the mixed list of
 * pairs, cheapest pair first, crosses into the next family part-way
 * through the previous one's efforts. The comparison's `sonnet_medium .05,
 * sonnet_high .39, sonnet_xhigh .13, opus_high .37` reaches half on
 * `sonnet_xhigh`, an effort Jev gave 13%; and a split between `opus_high`
 * and `sonnet_max` lands on the Sonnet pair however little Jev put there,
 * since every Sonnet pair sits below every Opus pair. Summing per family
 * first asks the ordered question only of what is ordered, the models.
 */
export function pairPickOf(
  probabilities: unknown,
  offered: readonly Pair[],
  minConfidence: number = DEFAULT_CONFIDENCE_FLOOR,
  choice?: unknown,
): PairPick | undefined {
  const shares = pairSharesOf(probabilities, offered);
  if (shares === undefined) return undefined;
  const pairs = PAIRS.filter((p) => p in shares);
  const families = familySharesOf(shares);
  const tiers = TIERS.filter((t) => t in families);
  const share = (p: Pair) => shares[p] ?? 0;

  const most = Math.max(...pairs.map(share));
  const tops = pairs.filter((p) => share(p) >= most - SUM_SLACK);
  const top = isPair(choice) && tops.includes(choice) ? choice : tops[0]!;

  const tier =
    minConfidence > 0
      ? (tiers.find((t) => shareUpTo(shares, t) >= minConfidence - SUM_SLACK) ??
        tiers[tiers.length - 1]!)
      : topFamilyOf(families, tiers, pairOf(choice)?.tier);

  const own = pairs.filter((p) => pairOf(p)!.tier === tier);
  const majority = (families[tier] ?? 0) >= FAMILY_MAJORITY - SUM_SLACK;
  const effort = majority
    ? pairOf(topPairOf(own, share))!.effort
    : spreadEffortOf(shares, own);
  return {
    tier,
    effort,
    top,
    cumulative: shareUpTo(shares, tier),
    shares,
  };
}

/**
 * How much of Jev's probability a family must hold on its own for its
 * likeliest pair to be the effort (`pairPickOf`): half, a majority, the
 * same bar as the family rule's default (`DEFAULT_CONFIDENCE_FLOOR`). It is
 * not a setting: it says when a family's own ranking of its efforts is most
 * of the answer, which is not a matter of budget.
 */
export const FAMILY_MAJORITY = 0.5;

/** The pair in `pairs` with the most probability, ties to the lower effort. */
function topPairOf(pairs: readonly Pair[], share: (p: Pair) => number): Pair {
  const best = Math.max(...pairs.map(share));
  return pairs.find((p) => share(p) >= best - SUM_SLACK)!;
}

/**
 * The effort a whole pair distribution comes to, clamped into the efforts
 * of `own` (one family's offered pairs, which are its band): every pair's
 * share added up per effort level, whatever its family, and the median of
 * those in `EFFORTS` order, the lowest effort where at least half of the
 * probability says it or less is enough. Exactly half on a level takes
 * that level, so ties go to the lower effort.
 */
export function spreadEffortOf(
  shares: Readonly<Partial<Record<Pair, number>>>,
  own: readonly Pair[],
): Effort {
  const byEffort = new Map<Effort, number>();
  for (const [name, p] of Object.entries(shares)) {
    const effort = pairOf(name)?.effort;
    if (effort === undefined || typeof p !== "number") continue;
    byEffort.set(effort, (byEffort.get(effort) ?? 0) + p);
  }
  const total = [...byEffort.values()].reduce((s, p) => s + p, 0);
  let sum = 0;
  let median: Effort = EFFORTS[EFFORTS.length - 1]!;
  for (const effort of EFFORTS) {
    sum += byEffort.get(effort) ?? 0;
    if (sum >= total * FAMILY_MAJORITY - SUM_SLACK) {
      median = effort;
      break;
    }
  }
  const efforts = own.map((p) => EFFORTS.indexOf(pairOf(p)!.effort));
  return clampInto(
    { min: EFFORTS[Math.min(...efforts)]!, max: EFFORTS[Math.max(...efforts)]! },
    median,
  );
}

/** The family with the most probability, ties to `preferred`, else the cheapest. */
function topFamilyOf(
  families: Readonly<Partial<Record<Tier, number>>>,
  tiers: readonly Tier[],
  preferred: Tier | undefined,
): Tier {
  const most = Math.max(...tiers.map((t) => families[t] ?? 0));
  const tops = tiers.filter((t) => (families[t] ?? 0) >= most - SUM_SLACK);
  return preferred !== undefined && tops.includes(preferred)
    ? preferred
    : tops[0]!;
}

/**
 * Turns the `answers` object of a Jev response into a decision, or null
 * when nothing in it can be one; the caller then falls back to the
 * default.
 *
 * The answer to read is `route`, the one question `requestBodyOf` asks
 * (`routeDecisionOf`). An `answers` without it is read as an answer to the
 * two questions it replaced (`legacyDecisionOf`), so an answer recorded
 * before the change still decides as it did; Jev only ever answers what it
 * was asked, so a live answer is never read that way.
 */
export function decisionOf(
  answers: unknown,
  offered: readonly Tier[] = TIERS,
  ladder: Ladder = DEFAULT_LADDER,
  minConfidence = 0,
): Decision | null {
  if (!isRecord(answers)) return null;
  if ("route" in answers) {
    return routeDecisionOf(answers.route, offered, ladder, minConfidence);
  }
  return legacyDecisionOf(answers, offered, ladder, minConfidence);
}

/**
 * The decision a `route` answer comes to, over the pairs `offeredPairs`
 * gives for `offered` on `ladder`.
 *
 * The family and effort are `pairPickOf` at `minConfidence`; 0 takes the
 * family with the most probability, which is also what a caller that
 * passes no bar gets, so this alone still reads as "what Jev said"; the
 * router passes the person's bar. The effort is clamped into the family's
 * band, which changes nothing while the pairs offered are the ladder's
 * own. The decision's `confidence` is the family share behind the pick,
 * its `probabilities` the pair distribution, and `floored` names the
 * family of Jev's top pair when the pick's family sits above it.
 *
 * An answer whose probabilities cannot be read falls back to its
 * `choice`, taken as it stands when it is an offered pair, with the
 * answer's own `confidence` kept for the label only. Null when that fails
 * too: not a Choice answer, or a choice that is no offered pair.
 */
export function routeDecisionOf(
  route: unknown,
  offered: readonly Tier[] = TIERS,
  ladder: Ladder = DEFAULT_LADDER,
  minConfidence = 0,
): Decision | null {
  if (!isRecord(route) || route.type !== "choice") return null;
  const pairs = offeredPairs(offered, ladder);

  const pick = pairPickOf(route.probabilities, pairs, minConfidence, route.choice);
  if (pick !== undefined) {
    const topTier = pairOf(pick.top)!.tier;
    const above = TIERS.indexOf(pick.tier) > TIERS.indexOf(topTier);
    return {
      ...decisionFor(pick.tier, pick.cumulative, pick.effort, ladder),
      probabilities: pick.shares,
      ...(above ? { floored: topTier } : {}),
    };
  }

  const named = pairOf(route.choice);
  if (named === undefined || !pairs.includes(route.choice as Pair)) return null;
  return decisionFor(
    named.tier,
    finite(route.confidence) ?? 0,
    named.effort,
    ladder,
  );
}

/**
 * The decision an answer to the two-question request comes to: a Choice
 * `tier` among the families and a Score `effort` across `EFFORT_CRITERIA`.
 *
 * @deprecated The request asks one `route` question now (`routeDecisionOf`).
 * Kept so answers recorded under the old request (the evaluation
 * harness's previous design, a test's mock written before the change)
 * still decide exactly as they did.
 *
 * The tier is `tierOf` over the tier answer's probabilities at
 * `minConfidence`; the effort is the score's position, rounded, clamped
 * into the band of the tier picked, and the ladder's default effort when
 * the effort answer is missing or malformed. Without readable
 * probabilities the tier answer's `choice` is taken as it stands. Null when
 * the tier answer is missing, malformed, or names a tier not offered.
 */
export function legacyDecisionOf(
  answers: unknown,
  offered: readonly Tier[] = TIERS,
  ladder: Ladder = DEFAULT_LADDER,
  minConfidence = 0,
): Decision | null {
  if (!isRecord(answers)) return null;

  const tier = answers.tier as ChoiceAnswer | undefined;
  if (!isRecord(tier) || tier.type !== "choice") return null;

  const effortAnswer = answers.effort as ScoreAnswer | undefined;
  const effort = effortOf(effortScoreOf(effortAnswer), ladder.defaultEffort);
  const effortConfidence =
    isRecord(effortAnswer) && effortAnswer.type === "score"
      ? finite(effortAnswer.confidence)
      : undefined;
  const withEffortConfidence = (d: Decision): Decision =>
    effortConfidence === undefined ? d : { ...d, effortConfidence };

  const pick = tierOf(tier.probabilities, offered, minConfidence, tier.choice);
  if (pick !== undefined) {
    const above = TIERS.indexOf(pick.tier) > TIERS.indexOf(pick.top);
    return withEffortConfidence({
      ...decisionFor(pick.tier, pick.cumulative, effort, ladder),
      probabilities: pick.shares,
      ...(above ? { floored: pick.top } : {}),
    });
  }

  const choice = tier.choice;
  if (!isTier(choice)) return null;
  if (!offered.includes(choice)) return null;
  return withEffortConfidence(
    decisionFor(choice, finite(tier.confidence) ?? 0, effort, ladder),
  );
}

/**
 * The tier names of the fixed ladder this one replaced, and what each ran
 * on, for decisions kept in `$.state` before the change. `haiku` and
 * `fable` were already family names and need no entry.
 */
const LEGACY_RUNGS: Record<string, { tier: Tier; effort: Effort }> = {
  "sonnet-medium": { tier: "sonnet", effort: "medium" },
  "sonnet-high": { tier: "sonnet", effort: "high" },
  "opus-high": { tier: "opus", effort: "high" },
  "opus-max": { tier: "opus", effort: "max" },
};

/** A tier name from either ladder, as a family, or undefined. */
function tierFrom(name: unknown): Tier | undefined {
  if (isTier(name)) return name;
  return typeof name === "string" ? LEGACY_RUNGS[name]?.tier : undefined;
}

/**
 * A kept distribution, read back over the names that were kept, which are
 * the ones offered when it was decided; the shares were renormalised then,
 * so this changes none of them. Pair names when there are any, since that
 * is what a decision made from the `route` question keeps; family names
 * otherwise, for one kept before it. Undefined when neither reads: not an
 * object, no name either knows, or nothing above 0.
 */
function storedSharesOf(raw: unknown): Shares | undefined {
  if (!isRecord(raw) || Array.isArray(raw)) return undefined;
  const pairs = PAIRS.filter((p) => p in raw);
  if (pairs.length > 0) return pairSharesOf(raw, pairs);
  const tiers = TIERS.filter((t) => t in raw);
  return tierSharesOf(raw, tiers);
}

/**
 * A decision read back from storage, in today's shape, or null when what
 * is there is not a decision at all.
 *
 * Decisions kept by an older copy name rungs (`opus-high`, `sonnet-medium`)
 * rather than families; each is read as the family and effort it ran on.
 * Either way the effort is clamped into its family's band on `ladder`, the
 * one the router runs on now, and the model is the family's own, so a
 * stored decision cannot carry a pairing the policy no longer allows: a
 * kept `haiku` at low comes back at medium, and a kept `opus` at max comes
 * back at high once the person has narrowed Opus to high. Reading a
 * decision back again at step time, with the ladder of that moment, is how
 * a band changed mid-session reaches work decided before the change. A
 * missing effort is the ladder's default. A mark (`held`, `floored`,
 * `capped`) naming something neither ladder knows is dropped rather than
 * failing the whole decision.
 *
 * Only the effort is re-clamped. The family stays what was decided, a
 * fallback included: a decision is a record of what Jev said, and a new
 * default model is for decisions made after it.
 *
 * The distribution comes back in whichever shape it was kept in
 * (`storedSharesOf`): on pairs for a decision made from the `route`
 * question, on families for one made before it. Neither is translated
 * into the other, since a family share says nothing about effort; every
 * check that reads it goes through `familySharesOf`, which reads both.
 *
 * `clamp: false` reads the decision back as it was kept, legacy shape
 * translated but the effort left alone (a missing one is still the
 * ladder's default). That is the copy to keep and to write back: a copy
 * clamped into a narrowed band and then stored again would make the
 * narrowing permanent, and widening the band would never give back the
 * effort Jev asked for. Whatever runs on it is clamped again at its step.
 */
export function revivedDecision(
  raw: unknown,
  ladder: Ladder = DEFAULT_LADDER,
  options: { clamp?: boolean } = {},
): Decision | null {
  if (!isRecord(raw)) return null;
  const tier = tierFrom(raw.tier);
  const confidence = finite(raw.confidence);
  if (tier === undefined || confidence === undefined) return null;

  const legacy =
    typeof raw.tier === "string" ? LEGACY_RUNGS[raw.tier] : undefined;
  const effort =
    legacy?.effort ??
    (isEffort(raw.effort) ? raw.effort : ladder.defaultEffort);

  const decision: Decision =
    options.clamp === false
      ? { tier, model: modelOf(tier), effort, confidence }
      : decisionFor(tier, confidence, effort, ladder);
  const effortConfidence = finite(raw.effortConfidence);
  if (effortConfidence !== undefined) {
    decision.effortConfidence = effortConfidence;
  }
  const probabilities = storedSharesOf(raw.probabilities);
  if (probabilities !== undefined) decision.probabilities = probabilities;
  for (const mark of ["held", "floored", "capped"] as const) {
    const named = tierFrom(raw[mark]);
    if (named !== undefined) decision[mark] = named;
  }
  if (typeof raw.fallback === "string") decision.fallback = raw.fallback;
  return decision;
}

/**
 * How much of Jev's probability a family must hold, its pairs added up
 * with every cheaper family's, before a turn may run on it (`pairPickOf`).
 * At 0.5 the pick is the median of Jev's distribution over the ordered
 * families: a cheap model is only taken
 * when at least half of what Jev believes says it, or something cheaper
 * still, is enough. A cheap model on a hunch is where a router saves
 * pennies and loses the afternoon; an expensive one Jev all but ruled out
 * is where it loses the pennies too.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * The floor from the environment, or the default when it is unusable. As
 * with the sticky bar, a value above 1 is read as a percentage. 0 is
 * allowed here and turns the floor off: the pick is Jev's top choice.
 */
export function floorOf(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONFIDENCE_FLOOR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CONFIDENCE_FLOOR;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio > 1) return DEFAULT_CONFIDENCE_FLOOR;
  return ratio;
}

/**
 * How much of Jev's probability is on Fable, every Fable pair added up,
 * among the pairs offered: what the Fable bar is held against under
 * "hardest". A decision kept before the pairs holds Fable's family share
 * directly, which reads the same.
 *
 * 0 for a decision with no distribution behind it: a choice-only answer,
 * or one kept before decisions carried their probabilities. Such a pick
 * has shown no probability on Fable, and its `confidence` (how
 * concentrated the answer was) is no stand-in for it, so it is capped.
 */
export function fableShareOf(decision: Decision): number {
  const shares = decision.probabilities;
  return shares === undefined ? 0 : (familySharesOf(shares).fable ?? 0);
}

/**
 * Holds a Fable pick to what the person's setting allows.
 *
 * Under "hardest" Fable is the tier for the exceptional few, so a Fable
 * pick only runs there when Jev put at least `fableConfidence` of its
 * probability on Fable itself, all its pairs together (`fableShareOf`). The
 * bar is on P(fable), not on the answer's
 * `confidence`: confidence measures how peaked the answer is, so a 50/50
 * split between Opus and Fable and a 50/50 split between Haiku and Fable
 * read the same to it, and neither says how likely Fable is to be needed.
 * A Fable pick under the bar still says the task is hard, so it runs on the
 * ceiling, Opus at the top of its band (`ceilingOf`: max, unless the person
 * narrowed it) whatever effort Jev gave, rather than on the default. Under
 * "never" Fable is not offered and a Fable decision should not exist; if
 * one does, it gets the same cap. Under "open" Fable is just the top of
 * the order, and a Fable pick is an ordinary pick.
 *
 * A capped decision keeps the distribution, and its `confidence` becomes
 * the share behind the ceiling, P(family <= opus). It keeps `floored` only
 * while the ceiling still sits above the top choice that mark names.
 *
 * A Fable decision that is the default rather than Jev's pick (a fallback,
 * only possible under "open") says nothing about how hard the task is.
 * Once the setting tightens, which the step-time re-gate is there to
 * catch, it becomes the fallback of the ladder of that moment, its reason
 * kept.
 *
 * Every other tier passes untouched.
 */
export function fableGate(
  fresh: Decision,
  fable: FableMode,
  fableConfidence: number,
  ladder: Ladder = DEFAULT_LADDER,
): Decision {
  if (fresh.tier !== "fable") return fresh;
  if (fable === "open") return fresh;
  if (fresh.fallback !== undefined) {
    return fallbackDecision(fresh.fallback, ladder);
  }
  if (fable === "hardest" && fableShareOf(fresh) >= fableConfidence - SUM_SLACK)
    return fresh;
  const ceiling = ceilingOf(ladder);
  const shares = fresh.probabilities;
  const floored =
    fresh.floored !== undefined &&
    TIERS.indexOf(ceiling.tier) > TIERS.indexOf(fresh.floored)
      ? fresh.floored
      : undefined;
  return {
    ...decisionFor(
      ceiling.tier,
      shares !== undefined ? shareUpTo(shares, ceiling.tier) : fresh.confidence,
      ceiling.effort,
      ladder,
    ),
    ...(fresh.effortConfidence !== undefined
      ? { effortConfidence: fresh.effortConfidence }
      : {}),
    ...(shares !== undefined ? { probabilities: shares } : {}),
    ...(floored !== undefined ? { floored } : {}),
    capped: fresh.tier,
  };
}

/** The settings `gatedDecision` reads, as `RouterConfig` names them. */
export type Gate = {
  fable: FableMode;
  fableConfidence: number;
};

/**
 * A Jev pick after every check that applies to a turn and a subagent
 * alike, once the pick itself is made: today, the Fable gate. The floor is
 * not here any more, because it is no longer a check on a pick but the way
 * the pick is made (`pairPickOf`, through `decisionOf`), and that needs
 * Jev's whole distribution before clamping, which a decision no
 * longer has once made. Stickiness comes after this and only on the main
 * loop, so it is left to the caller.
 */
export function gatedDecision(
  fresh: Decision,
  gate: Gate,
  ladder: Ladder = DEFAULT_LADDER,
): Decision {
  return fableGate(fresh, gate.fable, gate.fableConfidence, ladder);
}

/**
 * How much of Jev's probability must say the cheaper model is enough,
 * P(tier <= the fresh pick), before a switch down moves the model, when
 * stickiness is on.
 *
 * The prompt cache is per model: a session cached under one model is cold
 * for the next, so the turn that switches pays full input tokens. A router
 * that flips whenever half of Jev's belief says the cheaper model will do
 * can pick the cheaper model every time and still cost more. 0.75 is the starting point, not a measured optimum; retune it
 * with `npm run try-prompts`.
 */
export const DEFAULT_STICKY_CONFIDENCE = 0.75;

/** Whether stickiness is on. Off unless the env var says otherwise. */
export function stickyOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

/**
 * The bar from the environment, or the default when it is unusable.
 *
 * A value above 1 is read as a percentage, since `JEV_ROUTER_STICKY_CONFIDENCE=80`
 * is the likelier intent than a bar no turn can ever clear. 0 and 1 are both
 * refused: one would hold every switch forever, the other would hold none,
 * and each is better said by leaving the flag off.
 */
export function thresholdOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STICKY_CONFIDENCE;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio <= 0 || ratio >= 1) return DEFAULT_STICKY_CONFIDENCE;
  return ratio;
}

/**
 * Holds a shaky switch down on the model the last turn used.
 *
 * Only a move to a cheaper family is ever held, and only when less than
 * `threshold` of Jev's probability says the cheaper family or something
 * cheaper still is enough: P(family <= the fresh pick), its pairs added up
 * per family, which is the fresh decision's `confidence` (`pairPickOf`),
 * read from its distribution when it carries one. A pick the cumulative rule already took at 50% is held at
 * 75% until Jev is that much surer the cheaper model will do; a decision
 * with no distribution (a choice-only answer) is held to its
 * `confidence`, the only number it has. A move up goes through at
 * any confidence, because staying on a weaker model to save a cold cache is
 * the one hold that can cost correctness. A move that keeps the model is
 * never a switch at all: effort costs no cache.
 *
 * Only the model is held. The effort Jev asked for is applied either way,
 * clamped into the held family's band on `ladder`, so a held turn still
 * thinks as hard as Jev said and never at a pairing the policy does not
 * offer. A `previous` on a family the ladder does not know (a stale shape
 * from storage) is never held to: it reads as below everything, so any
 * fresh pick is a move up.
 *
 * A turn is never held on Fable. Holding there would run a turn on the
 * dearest model when Jev did not pick it, past `fableGate`, and a warm
 * cache on Fable is worth less than the price gap to whatever Jev did pick.
 *
 * A fallback is never held either. It is not a shaky pick but no pick at
 * all, and it is the ladder's default by design: held, a dead provider
 * would run on whatever the last turn ran on and lose its `fallback`
 * mark, so the failure would read as an ordinary hold. A floored pick can
 * be held, and keeps its `floored` mark, so the line still says both.
 *
 * A held decision's `confidence` is the share behind the tier it runs on,
 * P(tier <= the previous one), like every other decision's: the number on
 * the line is always about the model that ran. The share behind the cheaper
 * pick that was refused is what the hold was decided on, and `held` names
 * that pick; a decision with no distribution keeps its only number.
 *
 * `previous` is the decision the last routed turn ran on, or null on the
 * first turn of a session, which has nothing to hold to.
 */
export function stickyDecision(
  fresh: Decision,
  previous: Decision | null,
  threshold: number,
  ladder: Ladder = DEFAULT_LADDER,
): Decision {
  if (previous === null) return fresh;
  if (previous.tier === "fable") return fresh;
  if (fresh.fallback !== undefined) return fresh;
  if (fresh.model === previous.model) return fresh;
  if (TIERS.indexOf(fresh.tier) > TIERS.indexOf(previous.tier)) return fresh;
  const enough =
    fresh.probabilities !== undefined
      ? shareUpTo(fresh.probabilities, fresh.tier)
      : fresh.confidence;
  if (enough >= threshold - SUM_SLACK) return fresh;
  return {
    tier: previous.tier,
    model: previous.model,
    effort: clampEffort(previous.tier, fresh.effort, ladder),
    confidence:
      fresh.probabilities !== undefined
        ? shareUpTo(fresh.probabilities, previous.tier)
        : fresh.confidence,
    ...(fresh.effortConfidence !== undefined
      ? { effortConfidence: fresh.effortConfidence }
      : {}),
    ...(fresh.probabilities !== undefined
      ? { probabilities: fresh.probabilities }
      : {}),
    ...(fresh.floored !== undefined ? { floored: fresh.floored } : {}),
    held: fresh.tier,
  };
}
