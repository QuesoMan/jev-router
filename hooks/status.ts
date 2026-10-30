/**
 * What `/jev` prints. This is the router's only guaranteed-visible surface:
 * a command's output row draws on every surface, where a footer label may
 * not, so anything you need to be sure of belongs here.
 */

import {
  BAND_SETTING,
  CONFIG_ENV,
  configOf,
  DEFAULT_CONFIG,
  type ContextConfig,
  type ContextMode,
  type FableMode,
  type LadderConfig,
  type RouterConfig,
  type RouterSettings,
} from "./config.ts";
import type { JevResult } from "./jev.ts";
import { doubtOf, LOW_CONFIDENCE, marksOf, rungOf } from "./label.ts";
import {
  ceilingOf,
  guardTargetOf,
  decisionOf,
  DEFAULT_LADDER,
  DEFAULT_STICKY_CONFIDENCE,
  fallbackDecision,
  gatedDecision,
  ladderOf,
  modelOf,
  stickyDecision,
  TIERS,
  type Decision,
  type Ladder,
  type Tier,
} from "./policy.ts";
import type { ProviderResult } from "./provider.ts";

/**
 * What the API said a turn cost, and which model it says answered. The
 * shape of the engine's `TurnUsage`, spelled out here so this file stays
 * free of engine types and runs under plain `node`.
 */
export type Usage = {
  /** The model that answered, by the id the API reports. */
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** Everything an attempt carries besides how it was routed. */
type AttemptHead = {
  prompt: string;
  ms: number;
  usage?: Usage;
  /**
   * What started the turn, when it was not the person typing. Absent for a
   * typed prompt. `notify`: the main loop woke because a background task
   * finished, and the engine's `<task-notification>` was the turn's text.
   * `agent`: a subagent's own loop, from the Agent tool, a teammate or a
   * plugin's `$.agent.spawn`. `workflow`: an agent a Workflow script's
   * `agent()` started. `continue`: a main-loop turn the engine started with
   * no text at all, which runs on what the last turn ran on. Without this,
   * one prompt that spawned three reviewers read as one reply that changed
   * model three times.
   */
  kind?: "notify" | "agent" | "workflow" | "continue";
  /** For `agent` and `workflow`: which subagent, as its spawn described it. */
  agent?: AgentTag;
  /**
   * The model the caller asked a subagent to run on (the Agent tool's
   * `model`, a workflow script's `opts.model`), when it asked for one. Jev's
   * pick overrides it, so this is kept to show what was overridden: a
   * script that pins every agent to Fable is the bill this router exists to
   * stop, and the stop should be visible.
   */
  asked?: string;
  /**
   * A forbidden model a step of this turn named and was moved off, on a
   * turn with no decision of its own (a fork, a resume, the main loop
   * before routing was on). Kept for the same reason as `asked`.
   */
  blocked?: string;
};

/**
 * One turn's outcome, kept for the status report. `usage` arrives after the
 * decision, from the `stop` chunk of each step, so it is filled in later and
 * is absent for a turn still running or one whose response never came.
 *
 * Every turn the router sees while it is on gets a decision, a fallback
 * included. `skipped` is left for the subagent loops it saw no spawn for,
 * or chose not to route (forks, resumes): those run on what they were given.
 */
export type Attempt = AttemptHead &
  ({ decision: Decision } | { skipped: string });

/** An attempt that was routed, which every one `attemptOf` makes is. */
export type RoutedAttempt = AttemptHead & { decision: Decision };

/**
 * Which subagent a turn ran in. `type` is the definition (`general-purpose`,
 * `Explore`); `label` its task's description (`Review library-sync cluster`),
 * or the id when nothing describes it yet, in which case `type` is absent
 * too.
 */
export type AgentTag = {
  type?: string;
  label: string;
};

/**
 * The short tag for a turn nobody typed: `notify`, `continue`,
 * `agent:Explore`, `agent`, `workflow`, `workflow:Explore`.
 */
export function kindMark(
  attempt: Pick<Attempt, "kind" | "agent">,
): string | null {
  if (attempt.kind === "notify") return "notify";
  if (attempt.kind === "continue") return "continue";
  if (attempt.kind === "agent" || attempt.kind === "workflow")
    return attempt.agent?.type
      ? `${attempt.kind}:${attempt.agent.type}`
      : attempt.kind;
  return null;
}

/** Whether the attempt is a subagent's loop, whose reply is a tool result. */
export function isSubagent(attempt: Pick<Attempt, "kind">): boolean {
  return attempt.kind === "agent" || attempt.kind === "workflow";
}

/**
 * A label in square brackets a harness may put on its own line before an
 * envelope it delivers ("[SYSTEM NOTIFICATION - NOT USER INPUT]"): still
 * the envelope, and still nobody typing. Shared with `state.ts`, so that
 * what a row calls a notification and what Jev is never shown as the
 * developer's words cannot drift apart.
 */
export const ENVELOPE_PREAMBLE = String.raw`^\s*(?:\[[^\]\n]{1,200}\]\s*)?`;

/** The opening of the engine's task notification, preamble allowed. */
export const NOTIFICATION = new RegExp(`${ENVELOPE_PREAMBLE}<task-notification>`);
const tagOf = (text: string, tag: string) =>
  text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

/**
 * Reads the engine's task notification, when the turn's text is one: what
 * the row should say instead of the XML envelope.
 */
export function notificationOf(text: string): string | null {
  if (!NOTIFICATION.test(text)) return null;
  return tagOf(text, "summary") ?? `task ${tagOf(text, "task-id") ?? "?"}`;
}

/**
 * Folds one step's usage into its turn: counts sum, the model is the last
 * step's, as the engine defines a turn's usage. Mutates, because the same
 * object sits in the history and in the by-turn lookup.
 */
export function addUsage(attempt: Attempt, usage: Usage): void {
  const prior = attempt.usage;
  attempt.usage = {
    model: usage.model,
    input_tokens: (prior?.input_tokens ?? 0) + usage.input_tokens,
    output_tokens: (prior?.output_tokens ?? 0) + usage.output_tokens,
    cache_read_input_tokens:
      (prior?.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens,
    cache_creation_input_tokens:
      (prior?.cache_creation_input_tokens ?? 0) +
      usage.cache_creation_input_tokens,
  };
}

/**
 * How much of what the turn's requests carried was read from cache, 0 to 1.
 * Everything carried is uncached input plus cache reads plus cache writes;
 * this is the cost-relevant measure, since reads bill at a tenth.
 */
export function cacheRatio(usage: Usage): number {
  const carried =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;
  return carried === 0 ? 0 : usage.cache_read_input_tokens / carried;
}

/** Where a setting's value was read from. */
export type ConfigSource = "env" | "option" | "default";

export type ConfigSources = Readonly<
  Record<keyof RouterSettings, ConfigSource>
>;

/**
 * Two distinct values each field can hold, for asking `configOf` whether
 * the env var decided it: if the result is the same whichever option sits
 * under it, the env var won.
 *
 * A band's two are the narrowest bands at either end of the scale, which
 * no other band reads as, so the comparison works on the canonical names
 * `configOf` hands back as it does on numbers.
 */
const PROBES: {
  [K in keyof RouterSettings]: [RouterSettings[K], RouterSettings[K]];
} = {
  fable: ["never", "open"],
  fableConfidence: [0.3, 0.9],
  minConfidence: [0.3, 0.9],
  routeSubagents: [true, false],
  defaultModel: ["haiku", "sonnet"],
  defaultEffort: ["low", "max"],
  haikuEffort: ["low", "max"],
  sonnetEffort: ["low", "max"],
  opusEffort: ["low", "max"],
  fableEffort: ["low", "max"],
  context: ["full", "request"],
};

/** Every setting, in the order `/jev` reads them. */
const SETTING_KEYS = Object.keys(PROBES) as (keyof RouterSettings)[];

/**
 * Where each setting in `configOf(options, env)` came from.
 *
 * Worked out by asking `configOf` itself rather than parsing anything a
 * second time, so it cannot drift from what the router actually runs on.
 * An option equal to the default reads as the default: the engine fills
 * `userConfig` defaults in, so every option is "set", and calling the
 * manifest's default an option would make every line say so.
 */
export function configSourcesOf(
  options: Readonly<Record<string, unknown>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ConfigSources {
  const fromOptions = configOf(options, {});
  const sourceOf = <K extends keyof RouterSettings>(key: K): ConfigSource => {
    if (env[CONFIG_ENV[key]] !== undefined) {
      const [a, b] = PROBES[key];
      const under = (v: unknown) => configOf({ [key]: v }, env)[key];
      if (under(a) === under(b)) return "env";
    }
    return fromOptions[key] !== DEFAULT_CONFIG[key] ? "option" : "default";
  };
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, sourceOf(key)]),
  ) as Record<keyof RouterSettings, ConfigSource>;
}

export type Status = {
  enabled: boolean;
  surface: string | null;
  provider: ProviderResult;
  timeoutMs: number;
  /** The confidence a switch must clear, or null when stickiness is off. */
  sticky: number | null;
  /**
   * The settings in force: the Fable mode and its bar, the floor (the
   * share of Jev's probability a pick needs, 0 for Jev's top choice),
   * whether subagents are routed, the ladder's default and bands, and how
   * much of the session each question carries (`context`). The report builds the ladder from these with `ladderOf`, the
   * same call the router makes, so what it prints is what runs. A config
   * without the ladder's fields (one built before they existed) reads as
   * the default ladder.
   */
  config: RouterConfig & Partial<LadderConfig & ContextConfig>;
  /**
   * Where each setting came from, when the caller worked it out. The report
   * prints it beside the value, since "why is Fable on" is answered by "your
   * shell says so" more often than by the settings page.
   */
  sources?: ConfigSources;
  /** The families Jev is offered, after the Fable mode and the exclusions. */
  offered: readonly Tier[];
  excluded: readonly Tier[];
  announce: boolean;
  attempts: readonly Attempt[];
};

/**
 * How a decision is settled from Jev's answer: the pick at the floor, then
 * the Fable gate, then the hold. Stickiness is the main loop's alone, so a
 * subagent passes no `sticky`; the floor and the gate apply to every pick.
 *
 * Every field is optional and defaults to `DEFAULT_CONFIG`, so a caller
 * that predates the settings gets the money-saving policy, not a laxer one.
 */
export type Route = {
  /**
   * The share of Jev's probability that must say the cheaper model is
   * enough before a switch down, or null (absent) when switches are free.
   */
  sticky?: number | null;
  /** The decision the last routed main-loop turn ran on. */
  running?: Decision | null;
  /**
   * The share of Jev's probability a family must hold, its pairs added up
   * and every cheaper family's with them, to be picked (`pairPickOf`); 0
   * takes the family with the most. The effort is then Jev's likeliest
   * pair within the family, whatever the floor, or the median effort of
   * the whole answer when the family holds less than half of it.
   */
  floor?: number;
  /** How far up the ladder Fable is allowed. */
  fable?: FableMode;
  /** Under "hardest", the share of Jev's probability Fable needs to run. */
  fableConfidence?: number;
  /**
   * The bands every effort is clamped into, and the default a fallback
   * runs on. `DEFAULT_LADDER` when absent.
   */
  ladder?: Ladder;
};

/**
 * The settings a config describes, the ladder's filled in from
 * `DEFAULT_CONFIG` where it has none, so a config built before the ladder
 * was a setting reads as the default ladder rather than failing.
 */
export function settingsOf(
  config: RouterConfig & Partial<LadderConfig & ContextConfig>,
): RouterSettings {
  const settings: RouterSettings = { ...DEFAULT_CONFIG };
  for (const key of SETTING_KEYS) {
    const value = config[key];
    if (value !== undefined) Object.assign(settings, { [key]: value });
  }
  return settings;
}

/** The ladder a config describes; see `settingsOf` for one without it. */
export function ladderFrom(
  config: RouterConfig & Partial<LadderConfig & ContextConfig>,
): Ladder {
  return ladderOf(settingsOf(config));
}

/** The part of a route the settings decide: everything but the hold. */
export function routeOf(config: RouterConfig & Partial<LadderConfig & ContextConfig>): Route {
  return {
    floor: config.minConfidence,
    fable: config.fable,
    fableConfidence: config.fableConfidence,
    ladder: ladderFrom(config),
  };
}

/**
 * Why a turn ran on the default when Jev answered with nothing usable: no
 * probability on any pair the request offered, and a choice that is none
 * of them either. The name is older than the pairs; the words are not.
 */
export const NO_OFFERED_TIER = "Jev answered but named no pair we offered";

/**
 * The decision a turn runs on, whatever Jev's call came to.
 *
 * A failure is no longer a pass. It used to leave the turn on the session
 * model, which is whatever the person last set: on a session set to Fable,
 * a dead provider meant every turn on Fable. Now it is the ladder's
 * default, Opus at high effort unless the person set another, with the
 * reason kept on the decision so the line can still say why. (No provider
 * at all is not a failure but a router with nothing to ask, which is
 * routing off: the caller never gets this far.)
 *
 * Jev's pick is made at the floor (`decisionOf` at `route.floor`: family
 * first, the cumulative rule of `pairPickOf` over the families' summed
 * pair shares, then the likeliest pair within the family), then goes
 * through the Fable gate (`gatedDecision`), and the hold last, all on the
 * route's ladder: its bands are the pairs Jev was offered and clamp every
 * effort, and its default is what the fallback lands on. The floor comes
 * before the gate because it can move a pick up into Fable, and the gate
 * has to see what the turn would run on.
 */
export function routedDecisionOf(
  result: JevResult,
  offered: readonly Tier[],
  route: Route = {},
): Decision {
  const ladder = route.ladder ?? DEFAULT_LADDER;
  const floor = route.floor ?? DEFAULT_CONFIG.minConfidence;
  const picked = result.ok
    ? (decisionOf(result.answers, offered, ladder, floor) ??
      fallbackDecision(NO_OFFERED_TIER, ladder))
    : fallbackDecision(result.reason, ladder);
  const gated = gatedDecision(
    picked,
    {
      fable: route.fable ?? DEFAULT_CONFIG.fable,
      fableConfidence: route.fableConfidence ?? DEFAULT_CONFIG.fableConfidence,
    },
    ladder,
  );
  return route.sticky !== null && route.sticky !== undefined
    ? stickyDecision(gated, route.running ?? null, route.sticky, ladder)
    : gated;
}

/**
 * One main-loop turn's outcome from Jev's answer, so every way a turn can
 * fail to route lands in one place and gets announced the same way.
 */
export function attemptOf(
  text: string,
  result: JevResult,
  offered: readonly Tier[],
  route: Route = {},
): RoutedAttempt {
  return {
    ...headOf(text),
    ms: result.ms,
    decision: routedDecisionOf(result, offered, route),
  };
}

/** A main-loop turn's prompt as the row shows it, a notification read as one. */
function headOf(text: string): Pick<AttemptHead, "prompt" | "kind"> {
  const summary = notificationOf(text);
  return summary === null
    ? { prompt: text }
    : { prompt: summary, kind: "notify" as const };
}

/**
 * A main-loop turn the router chose not to route, with why: a continuation
 * with no earlier turn to carry on from, say.
 *
 * This is not a fallback. A fallback is for a call that was made and
 * failed, and it costs Opus at high effort; a turn with nothing to ask
 * about would
 * otherwise go there for no reason at all. So the turn runs on what
 * it was given, under the Fable guard alone, and says why. (No key at all
 * is not this either: that is routing off, and nothing is recorded.)
 */
export function unroutedAttemptOf(text: string, reason: string): Attempt {
  return { ...headOf(text), ms: 0, skipped: reason };
}

/**
 * A main-loop turn the engine started with no text (a continuation), on
 * the decision the last turn ran on.
 *
 * Jev is not asked: there is nothing to ask about, and an empty prompt used
 * to come back as a failed call, which put every continuation on the
 * default. A turn routed to Sonnet then continued on Opus, its cache thrown
 * away, and an Opus at max turn continued at high. The work has not
 * changed between the two turns, so neither does the model or the effort.
 */
export function continuedAttemptOf(decision: Decision): RoutedAttempt {
  return { prompt: "(continuation)", ms: 0, kind: "continue", decision };
}

/** What an `agent.spawn` says about the agent, as far as the row needs it. */
export type SpawnLike = {
  prompt: string;
  description?: string;
  subagentType?: string;
  /** Whether a workflow script's `agent()` started it. */
  workflow?: boolean;
  /** The model the caller asked for, if it asked. */
  model?: string;
};

/** A subagent's row, as far as its spawn describes it. */
function spawnHeadOf(spawn: SpawnLike): AttemptHead {
  const description = spawn.description?.trim() ?? "";
  const label = description !== "" ? description : spawn.prompt;
  const type = spawn.subagentType?.trim();
  const asked = spawn.model?.trim();
  return {
    prompt: label,
    ms: 0,
    kind: spawn.workflow ? "workflow" : "agent",
    agent: type ? { type, label } : { label },
    ...(asked ? { asked } : {}),
  };
}

/**
 * One subagent's outcome from Jev's answer about its task.
 *
 * No stickiness: a subagent starts with a fresh context, so there is no
 * cache for a hold to protect, and its first request pays full input
 * whichever model it lands on. A `sticky` in the route is ignored for that
 * reason; the Fable gate and the floor apply exactly as on the main loop.
 */
export function spawnAttemptOf(
  spawn: SpawnLike,
  result: JevResult,
  offered: readonly Tier[],
  route: Route = {},
): RoutedAttempt {
  return {
    ...spawnHeadOf(spawn),
    ms: result.ms,
    decision: routedDecisionOf(result, offered, {
      ...route,
      sticky: null,
      running: null,
    }),
  };
}

/**
 * A subagent the router chose not to route, with why, as its spawn
 * describes it. The row still names the agent and the model its caller
 * asked for, so a Fable request the guard moved is as visible as one Jev
 * overrode. (The hooks no longer record one at the spawn: a spawn left
 * alone is recorded at its first step, by `$.agent.list()`'s row.)
 */
export function unroutedSpawnOf(spawn: SpawnLike, reason: string): Attempt {
  return { ...spawnHeadOf(spawn), skipped: reason };
}

/** The last few turns, newest first, so the report stays one screen. */
export const HISTORY_LIMIT = 5;

function shorten(text: string, width = 44): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function attemptLine(attempt: Attempt): string {
  const when = `${String(attempt.ms).padStart(4)}ms`;
  const mark = kindMark(attempt);
  const what = `${mark ? `[${mark}] ` : ""}${shorten(attempt.prompt)}`;
  if ("skipped" in attempt) {
    // A subagent's row names the agent, since "unrouted" is the whole story.
    return attempt.kind !== undefined && attempt.kind !== "notify"
      ? `  ${when}  unrouted — ${what}`
      : `  ${when}  unrouted — ${attempt.skipped}`;
  }
  const { decision } = attempt;
  const rung = rungOf(decision);
  // A fallback has no confidence worth printing and a reason worth more, so
  // it trades the number for the reason. Both are shortened to stay inside
  // one screen.
  if (decision.fallback !== undefined) {
    return (
      `  ${when}  ${rung} fallback — ${shorten(decision.fallback, 30)}` +
      `  ${shorten(what, 34)}`
    );
  }
  // A marked turn says why it is not simply Jev's top choice, which is
  // more use than "(under half)" beside it; the number is the share of
  // Jev's probability behind the tier it runs on, held turns included.
  // "(under half)" says what the number is, not how sure Jev was: it marks
  // a tier that less than half of Jev's probability says is enough.
  const marks = marksOf(decision);
  const doubt =
    marks.length > 0
      ? marks.join(" ")
      : decision.confidence < LOW_CONFIDENCE
        ? "(under half)"
        : "";
  return `  ${when}  ${rung} ${decision.confidence.toFixed(2)}${doubt ? ` ${doubt}` : ""}  ${what}`;
}

/**
 * The line under a subagent's row saying which model its caller asked for
 * and where it went instead, or which forbidden model a step was moved off.
 */
function overrideLine(attempt: Attempt, ladder: Ladder): string | null {
  if (attempt.asked !== undefined && "decision" in attempt) {
    return `          asked ${shorten(attempt.asked, 40)} → ${rungOf(attempt.decision)}`;
  }
  if (attempt.blocked !== undefined) {
    return `          blocked ${shorten(attempt.blocked, 40)} → ${guardRung(ladder)}`;
  }
  return null;
}

/** The ladder's default as labels spell it: `opus·high`. */
function defaultRung(ladder: Ladder): string {
  return `${ladder.defaultTier}·${ladder.defaultEffort}`;
}

/**
 * Where the Fable guard sends a request it refuses, as labels spell it:
 * the default, lifted to Opus when it sits below (`guardTargetOf`).
 */
function guardRung(ladder: Ladder): string {
  const { tier, effort } = guardTargetOf(ladder);
  return `${tier}·${effort}`;
}

/** The ceiling while Fable is refused, as labels spell it: `opus·max`. */
function ceilingRung(ladder: Ladder): string {
  const { tier, effort } = ceilingOf(ladder);
  return `${tier}·${effort}`;
}

/** Thousands, rounded, for token counts: 130k, 2k, 0k. */
function kOf(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

/**
 * The line under a turn saying what the API reports actually answered, and
 * what the requests carried. This is the intrinsic check: the route line is
 * what we asked for; this is what we got.
 *
 * A dated id (`claude-opus-5-20260901`) still confirms `claude-opus-5`. A
 * different model is marked `≠`, which is the one case worth looking at.
 */
function usageLine(attempt: Attempt): string | null {
  const usage = attempt.usage;
  if (!usage) return null;

  let verdict = "";
  if ("decision" in attempt) {
    const asked = attempt.decision.model;
    const matches =
      usage.model === asked || usage.model.startsWith(`${asked}-`);
    verdict = matches ? " ✓" : ` ≠ ${asked}`;
  }

  const carried =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;
  const pct = Math.round(cacheRatio(usage) * 100);
  return (
    `          answered ${usage.model}${verdict}  ` +
    `cache ${pct}%  ${kOf(carried)} in  ${kOf(usage.output_tokens)} out`
  );
}

/**
 * The decision's part of a line: `opus·high · 91%`, or `opus·high · fallback
 * — timed out after 1500ms` when Jev was not the one who picked it, then its
 * marks and the turn's kind, as words for the caller to join.
 */
function decisionWords(attempt: RoutedAttempt): string[] {
  const { decision } = attempt;
  const rung = rungOf(decision);
  const head =
    decision.fallback !== undefined
      ? [rung, `fallback — ${decision.fallback}`]
      : [
          rung,
          `${Math.round(decision.confidence * 100)}%${doubtOf(decision)}`,
          ...marksOf(decision),
        ];
  const kind = kindMark(attempt);
  return kind === null ? head : [...head, kind];
}

/**
 * The footer put at the end of a completed reply: what was asked for, and
 * what the API says answered.
 *
 * It goes at the end because `usage` only exists once the response is whole —
 * the stop chunk carries it. The route line at the top of the reply is the
 * immediate signal; this is the settled one.
 *
 * Fenced, because markdown collapses leading whitespace and joins consecutive
 * lines into one paragraph: unfenced, the rule and the two lines would render
 * as a single run-on. A fence keeps the alignment and reads as data, not prose.
 */
export function usageFooter(attempt: Attempt): string | null {
  const usage = attempt.usage;
  if (!usage) return null;

  const carried =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;
  const cost =
    `cache ${Math.round(cacheRatio(usage) * 100)}% · ` +
    `${kOf(carried)} in · ${kOf(usage.output_tokens)} out`;

  let jev: string;
  let api: string;

  if ("decision" in attempt) {
    const asked = attempt.decision.model;
    const matches =
      usage.model === asked || usage.model.startsWith(`${asked}-`);
    jev = [...decisionWords(attempt), `${attempt.ms}ms`].join(" · ");
    api = `${usage.model}${matches ? " ✓" : ` ≠ ${asked}`} · ${cost}`;
  } else {
    jev = `unrouted — ${attempt.skipped}`;
    api = `${usage.model} · ${cost}`;
  }

  const rows = [`jev  ${jev}`, `api  ${api}`];
  // Count code points: the separators and check marks are multi-byte, and a
  // rule measured in UTF-16 units would overshoot the text it sits above.
  const width = Math.max(...rows.map((r) => [...r].length));
  return ["```", "─".repeat(width), ...rows, "```"].join("\n");
}

/**
 * The ladder as the report prints it, one family a line: the model each
 * family runs on, and the efforts it may run at. Each effort in the range
 * is one pair Jev is offered (`opus_xhigh`), so the line is the whole of
 * what a pick on the family can cost. The default family carries the default
 * effort too, since "opus" alone does not say Opus at high is the norm.
 *
 * The bands are the ladder's, the person's settings included. A band
 * somebody set says where from (`(env)`, `(option)`); one nobody set says
 * nothing, since four `(default)`s beside a `(default: high)` read as
 * noise, and a band with no source is the one a new user gets.
 */
function ladderLines(
  offered: readonly Tier[],
  ladder: Ladder,
  sources: ConfigSources | undefined,
): string[] {
  const width = Math.max(...TIERS.map((t) => t.length));
  const modelWidth = Math.max(...TIERS.map((t) => modelOf(t).length));
  return TIERS.filter((t) => offered.includes(t)).map((tier, i) => {
    const label = i === 0 ? "  ladder    " : "            ";
    const range = rangeOf(ladder.bands[tier]);
    const source = sources?.[BAND_SETTING[tier]];
    const from = source !== undefined && source !== "default" ? ` (${source})` : "";
    const tag =
      tier === ladder.defaultTier ? `  (default: ${ladder.defaultEffort})` : "";
    return (
      `${label}${tier.padEnd(width)}  ${modelOf(tier).padEnd(modelWidth)}` +
      `  ${range}${from}${tag}`
    ).trimEnd();
  });
}

/**
 * The default in one line, where each half came from, and a line more for
 * each part of the setting the ladder could not take as asked: a default
 * model of Fable the Fable setting forbids (Opus stands in), or a default
 * effort outside the default model's band (clamped into it). A refused
 * setting nobody is told about reads as a router ignoring its settings.
 */
function defaultLines(
  config: RouterSettings,
  ladder: Ladder,
  from: (key: keyof RouterSettings) => string,
): string[] {
  const where =
    from("defaultModel") === "" && from("defaultEffort") === ""
      ? ""
      : ` — model${from("defaultModel")}, effort${from("defaultEffort")}`;
  const lines = [
    `  default   ${defaultRung(ladder)}${where}, for fallbacks and anything unclear`,
  ];
  if (ladder.refusedTier !== undefined) {
    lines.push(
      `            ${ladder.refusedTier} can't be the default under ` +
        `${config.fable}, so ${ladder.defaultTier}`,
    );
  }
  if (ladder.clampedEffort !== undefined) {
    const band = rangeOf(ladder.bands[ladder.defaultTier]);
    lines.push(
      `            ${ladder.clampedEffort} is outside ${ladder.defaultTier}'s ` +
        `band (${band}), so ${ladder.defaultEffort}`,
    );
  }
  return lines;
}

/**
 * A band as the report prints it: `medium–max`, or `high` for a band of
 * one level. The en dash is one `bandOf` reads back, so a band copied from
 * here into a shell profile still works.
 */
function rangeOf(band: Ladder["bands"][Tier]): string {
  return band.min === band.max ? band.min : `${band.min}–${band.max}`;
}

/**
 * What the Fable guard refuses under each mode: the requests nobody routed,
 * since a decision is already held to the setting by the gate.
 */
const BLOCKED: Record<FableMode, string> = {
  never: "fable, whatever asks for it",
  hardest: "fable, unless Jev itself picks it",
  open: "nothing, fable is open",
};

/**
 * The Fable setting in one line, with its bar under "hardest", where the
 * bar, a share of Jev's probability on Fable itself, is what decides
 * whether a pick runs there or on Opus at the top of its band (max, unless
 * the person narrowed it).
 */
function fableLine(
  config: RouterSettings,
  ladder: Ladder,
  from: (key: keyof RouterSettings) => string,
): string {
  const head = `  fable     ${config.fable}${from("fable")}`;
  if (config.fable === "never")
    return `${head} — ${ceilingRung(ladder)} is the ceiling`;
  if (config.fable === "open") return `${head} — an ordinary family`;
  return (
    `${head} — a pick needs ${Math.round(config.fableConfidence * 100)}%` +
    `${from("fableConfidence")} on fable, else ${ceilingRung(ladder)}`
  );
}

/**
 * The floor in one line: the share of Jev's probability a model needs,
 * its pairs added up and every cheaper model's with them, to be picked;
 * the effort is then the likeliest of that model's pairs, or the median
 * effort of the whole answer when that model holds under half of it
 * (`pairPickOf`). The rule is the
 * same whatever the default is, since it reads Jev's distribution over the
 * ordered families, not the default; off, the pick is the family with the
 * most of Jev's probability, and the line says so as "Jev's top choice".
 */
function floorLine(
  config: RouterSettings,
  from: (key: keyof RouterSettings) => string,
): string {
  const head = "  floor     ";
  if (config.minConfidence === 0) {
    return (
      `${head}off — Jev's top choice (JEV_ROUTER_MIN_CONFIDENCE)` +
      from("minConfidence")
    );
  }
  return (
    `${head}a pick needs ${Math.round(config.minConfidence * 100)}%` +
    `${from("minConfidence")} of Jev's probability on its model or cheaper`
  );
}

/**
 * What leaves the machine with each question to TypeSafe, under each
 * context setting, in one line of the report: the fields `state.ts`
 * builds, in a few words. "Recent chat" is the last few messages and,
 * beside a short subagent brief, the developer's last request; a
 * subagent's brief goes with its description, agent type and whether a
 * workflow started it. The README lists the fields one by one.
 */
export const CONTEXT_SENT: Readonly<Record<ContextMode, string>> = {
  full: "sends the request, recent chat (may quote tool output), files",
  request: "sends only the request, or a subagent's brief; no transcript",
};

/**
 * The routing line: on, off by `/jev off`, or off because there is nothing
 * to ask. The last is the state the mod is installed in, so it says so in
 * as many words rather than printing "on" above a provider that is not.
 */
function routingLine(status: Status): string {
  if (!status.enabled) return "off (/jev on)";
  if (!status.provider.ok) return "off — no Jev key is set, so nothing is routed";
  return "on";
}

/**
 * The report, as plain lines. Written so the first three tell you whether
 * the thing is on at all, which is the question that brings people here.
 */
export function statusReport(status: Status): string {
  const lines: string[] = ["jev-router"];
  const active = status.enabled && status.provider.ok;

  lines.push(`  routing   ${routingLine(status)}`);
  lines.push(`  surface   ${status.surface ?? "unknown"}`);

  if (status.provider.ok) {
    const key =
      status.provider.name === "typesafe"
        ? "TYPESAFE_API_KEY"
        : "AI_GATEWAY_API_KEY";
    lines.push(`  provider  ${status.provider.name} · ${key} is set`);
  } else {
    // How to fix it, not only that it is broken: with no key the mod is as
    // off as after `/jev off`, and nothing else would say why.
    lines.push(`  provider  NO KEY — ${status.provider.reason}`);
    lines.push(
      "            set TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY) in the shell",
    );
    lines.push(
      '            that starts Claude Code, or under "env" in settings.json,',
    );
    lines.push("            then run /jev again");
  }

  const config = settingsOf(status.config);
  const ladder = ladderOf(config);
  const from = (key: keyof RouterSettings) => {
    const source = status.sources?.[key];
    return source !== undefined ? ` (${source})` : "";
  };

  lines.push(`  budget    ${status.timeoutMs}ms`);
  lines.push(
    `  sticky    ${
      status.sticky === null
        ? "off (JEV_ROUTER_STICKY=1)"
        : `on, switch needs ${Math.round(status.sticky * 100)}%`
    }`,
  );
  lines.push(fableLine(config, ladder, from));
  lines.push(...defaultLines(config, ladder, from));
  lines.push(...ladderLines(status.offered, ladder, status.sources));
  lines.push(floorLine(config, from));
  // Off means off: the guard is part of routing, and goes down with it.
  lines.push(
    `  blocked   ${active ? BLOCKED[config.fable] : "nothing, routing is off"}`,
  );
  lines.push(
    `  agents    ${
      config.routeSubagents
        ? "each new subagent and workflow agent asks Jev"
        : "not routed, each runs on what it was given"
    }${from("routeSubagents")}`,
  );
  lines.push(
    `  context   ${config.context}${from("context")} — ${CONTEXT_SENT[config.context]}`,
  );
  lines.push(
    `  announce  ${status.announce ? "on, a line per turn" : "off (/jev loud)"}`,
  );
  if (status.excluded.length > 0) {
    lines.push(`  excluded  ${status.excluded.join(", ")}`);
  }

  lines.push("");
  if (status.attempts.length === 0) {
    lines.push("  No turns yet. Send a prompt, then run /jev again.");
    return lines.join("\n");
  }

  lines.push("  Recent turns, newest first:");
  for (const attempt of status.attempts) {
    lines.push(attemptLine(attempt));
    const override = overrideLine(attempt, ladder);
    if (override !== null) lines.push(override);
    const usage = usageLine(attempt);
    if (usage !== null) lines.push(usage);
  }

  return lines.join("\n");
}

/**
 * The reply to `/jev on` and `/jev off`. `/jev on` with no key to ask
 * through says it changed nothing yet: routing is off either way until a
 * key is set.
 */
export function toggleReply(
  enabled: boolean,
  provider?: ProviderResult,
): string {
  if (!enabled) {
    return (
      "Jev routing off. Every turn, subagent and request runs exactly as it " +
      "came, Fable included. /jev on to route again."
    );
  }
  if (provider !== undefined && !provider.ok) {
    return (
      `Jev routing on, but nothing is routed yet: ${provider.reason}. ` +
      "Set TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY), then run /jev."
    );
  }
  return "Jev routing on. The next turn picks its own model.";
}

/**
 * The line put at the top of each reply, as markdown.
 *
 * Markdown, because the line rides in the reply's own text and that is what
 * the transcript renders. A blockquote sets it off from prose with a rail
 * and dimmer text; the rung is inline code, which the theme colours. Neither
 * a render hook nor `$.ui.log` drew anything in the desktop app, so this is
 * the styling that is actually available.
 *
 * A fallback keeps the warning sign it had when it was "unrouted": the turn
 * runs, on a known rung, but Jev did not pick it, and that is still worth a
 * glance.
 */
export function liveLine(attempt: Attempt): string {
  if ("skipped" in attempt) {
    return `> ⚠️ \`unrouted\` · ${attempt.skipped}`;
  }

  const [rung, ...rest] = decisionWords(attempt);
  if (attempt.decision.fallback !== undefined) {
    return `> ⚠️ \`${rung}\`${rest.map((w) => ` · ${w}`).join("")}`;
  }
  return (
    `> ✳️ \`${rung}\`${rest.map((w) => ` · ${w}`).join("")}` +
    ` · ${attempt.ms}ms`
  );
}

/**
 * The rule drawn under the line, closing it off from the reply.
 *
 * It needs the blank line before it: `---` on the line after text is a setext
 * heading underline, which would turn the route into a heading instead.
 */
export const REPLY_SEPARATOR = "\n\n---\n\n";

/**
 * What sits between the reply's last text and the footer. A blank line, so
 * the fence opens a block of its own instead of joining the last paragraph.
 */
export const FOOTER_SEPARATOR = "\n\n";

/** The reply to `/jev quiet` and `/jev loud`. */
export function announceReply(announce: boolean): string {
  return announce
    ? "Jev will announce each route in the transcript."
    : "Jev will route quietly. Run /jev to see what it has been doing.";
}

/**
 * Reads `/jev sticky`, `/jev sticky off`, `/jev sticky 0.6` and says what the
 * bar is now. `current` is the session's bar, or null when it is off.
 *
 * A bare `sticky` keeps a bar already set rather than resetting it to the
 * default, so turning it off and on again does not silently lose a tuned
 * value. A number that cannot be a confidence changes nothing and says so,
 * rather than falling back to the default: an unnoticed 0.75 is worse than a
 * refusal, since the point of the bar is knowing which one you are running.
 */
export function stickyCommand(
  rest: string,
  current: number | null,
): { sticky: number | null; text: string } {
  const arg = rest.trim().toLowerCase().replace(/%$/, "");

  if (arg === "off") {
    return {
      sticky: null,
      text: "Switching freely again. /jev sticky holds a shaky switch.",
    };
  }

  if (arg === "" || arg === "on") {
    const bar = current ?? DEFAULT_STICKY_CONFIDENCE;
    return { sticky: bar, text: stuckAt(bar) };
  }

  const parsed = Number(arg);
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(parsed) || ratio <= 0 || ratio >= 1) {
    return {
      sticky: current,
      text:
        `"${rest.trim()}" is not a confidence. Give a number between 0 and 1 ` +
        "(0.6), or a percentage (60).",
    };
  }
  return { sticky: ratio, text: stuckAt(ratio) };
}

function stuckAt(bar: number): string {
  return (
    `Holding the model until Jev is ${Math.round(bar * 100)}% sure of a switch down. ` +
    "/jev sticky off to switch freely."
  );
}
