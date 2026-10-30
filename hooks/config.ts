/**
 * The settings a person sharing this router can change, and where each one
 * is read from.
 *
 * The mod is passed around, so the money-saving policy is the default and
 * the things people disagree about are settings: how willing they are to
 * pay for Fable, which model is the default, how hard each model may
 * think, and how much of the session leaves the machine with each question. Each field is read from the environment first, then from the
 * plugin's `userConfig` options (what `/config` shows), then from
 * `DEFAULT_CONFIG`. A value that cannot be read is skipped rather than
 * thrown on: a typo in a shell profile should cost the person their
 * override, not their router.
 *
 * Each field is read on its own. How they bear on one another (a default
 * model of Fable the Fable setting forbids, a default effort outside the
 * default model's band) is `ladderOf`'s business in `policy.ts`, which
 * says so rather than refusing the setting here, so `/jev` can show both
 * what was asked and what runs.
 *
 * Nothing here touches the engine, so it runs under plain `node` in tests.
 * `register.ts` reads the env vars named in `CONFIG_ENV_KEYS` through
 * `$.env.get` and hands them in.
 */

import {
  bandName,
  bandOf,
  DEFAULT_BANDS,
  DEFAULT_EFFORT,
  DEFAULT_TIER,
  isEffort,
  isTier,
  type Effort,
  type Tier,
} from "./policy.ts";

/**
 * How far the router may go up to Fable.
 *
 * "never" (the default) keeps Opus at max effort as the ceiling: Fable is
 * not offered to Jev, and a request for it from anywhere is clamped.
 * "hardest" offers Fable for the exceptional few where even Opus at max
 * would likely fall short, and takes a Fable pick only when Jev put enough
 * of its probability on Fable (`fableConfidence`); nothing but Jev's own
 * pick may run on it. "open"
 * offers Fable for planning, architecture, systematic debugging and
 * research, and lets a session or a script ask for it as well.
 */
export type FableMode = "never" | "hardest" | "open";

/**
 * How much of the session Jev is shown with each question (`state.ts`).
 *
 * "full" (the default) sends what a person would look at to judge a short
 * request: the request, the last few messages of the conversation, the
 * files in play and whether the turn follows earlier ones, and beside a
 * thin subagent brief the developer's last request. "request" sends only
 * what the routing is about: a turn's request, and a subagent's brief with
 * its description, agent type and whether a workflow started it. The
 * agent's side of the conversation can quote tool output (a file, a
 * command's result, a secret it printed), so "request" is the choice for a
 * session whose transcript should stay on the machine; the price is that a
 * bare "do the same for the other one" is judged on those words alone.
 */
export type ContextMode = "full" | "request";

export type RouterConfig = {
  fable: FableMode;
  /**
   * Under "hardest", how much of Jev's probability must be on Fable itself,
   * P(fable) with every Fable pair added up, among the pairs offered, for a
   * Fable pick to run on Fable.
   * Below it the turn runs on Opus at the top of its band instead. Not the
   * answer's `confidence`, which says how peaked the answer is, not how
   * likely Fable is to be needed. In (0, 1].
   */
  fableConfidence: number;
  /**
   * How much of Jev's probability a family must hold, its pairs added up
   * with every cheaper family's, to be picked: the family is the cheapest
   * offered one f with P(family <= f) at or above this (`pairPickOf` in
   * `policy.ts`), and the effort the likeliest pair within it, or the
   * median effort of the whole answer when the family holds less than half
   * of it. At 0.5, the
   * default, that is the median of Jev's distribution over the ordered
   * families; higher leans toward stronger models, lower toward cheaper
   * ones. In [0, 1]; 0 turns the floor off and takes the family with the
   * most probability. The name is the one it had when it was a bar on the
   * answer's `confidence`, kept so settings already set still mean "how
   * sure before going cheap".
   */
  minConfidence: number;
  /** Whether Agent-tool subagents and workflow `agent()`s are routed too. */
  routeSubagents: boolean;
};

/**
 * The setting that decides what goes into each question's state. Kept
 * apart from `RouterConfig`, as the ladder's are, so code typed against
 * that still holds; `configOf` hands back every setting at once.
 */
export type ContextConfig = {
  /** How much of the session each question carries. "full" unless set. */
  context: ContextMode;
};

/**
 * The settings that shape the ladder: the default and the effort bands.
 * `ladderOf` in `policy.ts` turns them, with the Fable setting, into the
 * `Ladder` every decision is made on.
 *
 * The bands are kept as a setting spells them (`medium-high`, or `high`
 * for a band of one level), always in the canonical form `bandName`
 * writes, so two configs compare with `===` and the value reads back as
 * the person would type it.
 */
export type LadderConfig = {
  /**
   * The family a turn Jev could not route runs on, the one Jev is told
   * anything unclear belongs to, and what `/jev` calls the default. Opus unless
   * set. Fable is only usable under the "open" Fable setting; `ladderOf`
   * puts Opus in its place otherwise.
   */
  defaultModel: Tier;
  /**
   * The effort the default runs at, and the one any decision gets when Jev
   * gave none, clamped into the family's band. High unless set.
   */
  defaultEffort: Effort;
  /** How far Haiku may think, as a band name. `medium-high` unless set. */
  haikuEffort: string;
  /** How far Sonnet may think, as a band name. `medium-max` unless set. */
  sonnetEffort: string;
  /** How far Opus may think, as a band name. `medium-max` unless set. */
  opusEffort: string;
  /** How far Fable may think, as a band name. `medium-max` unless set. */
  fableEffort: string;
};

/**
 * Every setting the router reads: the routing ones and the ladder's.
 *
 * `RouterConfig` keeps the routing half under the name it has always had,
 * so code typed against it (and every record keyed by its fields) still
 * holds while the ladder's fields are new; `configOf` hands back this
 * whole set, which is a `RouterConfig` and a `LadderConfig` at once.
 */
export type RouterSettings = RouterConfig & LadderConfig & ContextConfig;

export const FABLE_MODES: readonly FableMode[] = ["never", "hardest", "open"];

export const CONTEXT_MODES: readonly ContextMode[] = ["full", "request"];

export const DEFAULT_CONFIG: RouterSettings = {
  fable: "never",
  fableConfidence: 0.75,
  minConfidence: 0.5,
  routeSubagents: true,
  defaultModel: DEFAULT_TIER,
  defaultEffort: DEFAULT_EFFORT,
  haikuEffort: bandName(DEFAULT_BANDS.haiku),
  sonnetEffort: bandName(DEFAULT_BANDS.sonnet),
  opusEffort: bandName(DEFAULT_BANDS.opus),
  fableEffort: bandName(DEFAULT_BANDS.fable),
  context: "full",
};

/** The env var each field is read from, ahead of the plugin option. */
export const CONFIG_ENV: Readonly<Record<keyof RouterSettings, string>> = {
  fable: "JEV_ROUTER_FABLE",
  fableConfidence: "JEV_ROUTER_FABLE_CONFIDENCE",
  minConfidence: "JEV_ROUTER_MIN_CONFIDENCE",
  routeSubagents: "JEV_ROUTER_SUBAGENTS",
  defaultModel: "JEV_ROUTER_DEFAULT_MODEL",
  defaultEffort: "JEV_ROUTER_DEFAULT_EFFORT",
  haikuEffort: "JEV_ROUTER_HAIKU_EFFORT",
  sonnetEffort: "JEV_ROUTER_SONNET_EFFORT",
  opusEffort: "JEV_ROUTER_OPUS_EFFORT",
  fableEffort: "JEV_ROUTER_FABLE_EFFORT",
  context: "JEV_ROUTER_CONTEXT",
};

/** The env names, for `register.ts` to read through `$.env.get`. */
export const CONFIG_ENV_KEYS: readonly string[] = Object.values(CONFIG_ENV);

/** The setting that holds each family's band. */
export const BAND_SETTING: Readonly<
  Record<Tier, "haikuEffort" | "sonnetEffort" | "opusEffort" | "fableEffort">
> = {
  haiku: "haikuEffort",
  sonnet: "sonnetEffort",
  opus: "opusEffort",
  fable: "fableEffort",
};

/** A Fable mode, case-insensitive, or undefined when it is not one. */
function fableModeOf(raw: unknown): FableMode | undefined {
  if (typeof raw !== "string") return undefined;
  const mode = raw.trim().toLowerCase();
  return (FABLE_MODES as string[]).includes(mode)
    ? (mode as FableMode)
    : undefined;
}

/** A context mode, case-insensitive, or undefined when it is not one. */
function contextModeOf(raw: unknown): ContextMode | undefined {
  if (typeof raw !== "string") return undefined;
  const mode = raw.trim().toLowerCase();
  return (CONTEXT_MODES as string[]).includes(mode)
    ? (mode as ContextMode)
    : undefined;
}

/**
 * A confidence from a number or a numeric string, or undefined when it is
 * unusable. As with the other bars, a value above 1 is read as a
 * percentage: `70` is the likelier intent than a bar no pick can clear.
 * `zero` says whether 0 is a value or a mistake; for the floor it turns the
 * floor off (Jev's top choice), for the Fable bar it would let every Fable
 * pick through however little of Jev's probability was on it.
 */
function confidenceOf(raw: unknown, zero: boolean): number | undefined {
  let parsed: number;
  if (typeof raw === "number") parsed = raw;
  else if (typeof raw === "string" && raw.trim() !== "") parsed = Number(raw);
  else return undefined;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio > 1) return undefined;
  if (ratio === 0 && !zero) return undefined;
  return ratio;
}

/** A flag from a boolean or the ways people actually set flags. */
function flagOf(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const flag = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  if (["0", "false", "no", "off"].includes(flag)) return false;
  return undefined;
}

/**
 * A family name, case-insensitive, or undefined when it is not one. Only
 * family names: the rung names of the old fixed ladder (`opus-high`) say
 * an effort too, which is `defaultEffort`'s to say.
 */
function familyNameOf(raw: unknown): Tier | undefined {
  if (typeof raw !== "string") return undefined;
  const tier = raw.trim().toLowerCase();
  return isTier(tier) ? tier : undefined;
}

/** An effort level, case-insensitive, or undefined when it is not one. */
function effortLevelOf(raw: unknown): Effort | undefined {
  if (typeof raw !== "string") return undefined;
  const effort = raw.trim().toLowerCase();
  return isEffort(effort) ? effort : undefined;
}

/**
 * A band, in the canonical spelling, or undefined when it is not one:
 * `bandOf` decides what reads (one level or `min-max`, any case, min at or
 * below max), and `bandName` writes it back the one way, so `HIGH`,
 * `high-high` and `high` are all `high`.
 */
function bandSettingOf(raw: unknown): string | undefined {
  const band = bandOf(raw);
  return band === undefined ? undefined : bandName(band);
}

/**
 * The first source that has a usable value for one field: the env var,
 * then the plugin option, then the default.
 */
function pick<T>(
  read: (raw: unknown) => T | undefined,
  fromEnv: string | undefined,
  fromOption: unknown,
  fallback: T,
): T {
  return read(fromEnv) ?? read(fromOption) ?? fallback;
}

/**
 * The router's settings from the plugin's options and the environment.
 *
 * `options` is what `register(on, options)` was handed, `userConfig`
 * defaults already filled in by the engine; it may be undefined where the
 * module is loaded without a manifest. `env` holds the `CONFIG_ENV_KEYS`
 * values, unset ones absent or undefined. Never throws.
 */
export function configOf(
  options: Readonly<Record<string, unknown>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): RouterSettings {
  const opt = options ?? {};
  const band = (key: (typeof BAND_SETTING)[Tier]) =>
    pick(bandSettingOf, env[CONFIG_ENV[key]], opt[key], DEFAULT_CONFIG[key]);
  return {
    fable: pick(
      fableModeOf,
      env[CONFIG_ENV.fable],
      opt.fable,
      DEFAULT_CONFIG.fable,
    ),
    fableConfidence: pick(
      (raw) => confidenceOf(raw, false),
      env[CONFIG_ENV.fableConfidence],
      opt.fableConfidence,
      DEFAULT_CONFIG.fableConfidence,
    ),
    minConfidence: pick(
      (raw) => confidenceOf(raw, true),
      env[CONFIG_ENV.minConfidence],
      opt.minConfidence,
      DEFAULT_CONFIG.minConfidence,
    ),
    routeSubagents: pick(
      flagOf,
      env[CONFIG_ENV.routeSubagents],
      opt.routeSubagents,
      DEFAULT_CONFIG.routeSubagents,
    ),
    defaultModel: pick(
      familyNameOf,
      env[CONFIG_ENV.defaultModel],
      opt.defaultModel,
      DEFAULT_CONFIG.defaultModel,
    ),
    defaultEffort: pick(
      effortLevelOf,
      env[CONFIG_ENV.defaultEffort],
      opt.defaultEffort,
      DEFAULT_CONFIG.defaultEffort,
    ),
    haikuEffort: band("haikuEffort"),
    sonnetEffort: band("sonnetEffort"),
    opusEffort: band("opusEffort"),
    fableEffort: band("fableEffort"),
    context: pick(
      contextModeOf,
      env[CONFIG_ENV.context],
      opt.context,
      DEFAULT_CONFIG.context,
    ),
  };
}
