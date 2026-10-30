import type { On, PluginOptions, StateDollar } from "claude-code";

import type {
  JevRouterAgent,
  JevRouterSwitches,
} from "../types/index.d.ts";
import {
  configOf,
  type ContextMode,
  type RouterSettings,
} from "./config.ts";
import {
  askJev,
  timeoutOf,
  type JevResult,
  type JevState,
} from "./jev.ts";
import { labelOf, withLabel } from "./label.ts";
import {
  clampEffort,
  DEFAULT_LADDER,
  excludedTiers,
  fableGate,
  familyOfModel,
  guardTargetOf,
  isEffort,
  isForbiddenModel,
  ladderOf,
  modelOf,
  offeredTiers,
  revivedDecision,
  stickyOf,
  thresholdOf,
  type Decision,
  type FableMode,
  type Ladder,
  type Tier,
} from "./policy.ts";
import { providerOf, type ProviderResult } from "./provider.ts";
import {
  briefStateOf,
  isEngineText,
  lastTypedRequestOf,
  THIN_BRIEF_CHARS,
  turnStateOf,
  type TranscriptRow,
  type TurnState,
} from "./state.ts";
import {
  addUsage,
  announceReply,
  attemptOf,
  configSourcesOf,
  continuedAttemptOf,
  HISTORY_LIMIT,
  isSubagent,
  liveLine,
  notificationOf,
  FOOTER_SEPARATOR,
  REPLY_SEPARATOR,
  routeOf,
  spawnAttemptOf,
  statusReport,
  toggleReply,
  stickyCommand,
  unroutedAttemptOf,
  usageFooter,
  type AgentTag,
  type Attempt,
  type ConfigSources,
  type SpawnLike,
} from "./status.ts";

/**
 * The most entries any of the router's lookups keeps before the oldest are
 * dropped. A leak guard, not the way entries leave: a turn's are deleted at
 * its `turn.complete`, and a spawn's handoff when the spawn answers. It used
 * to be 32 and the only way out, and a workflow fanning out to forty agents
 * evicted the turn that launched it, and the first agents with it, while
 * every one of them was still running.
 */
const CACHE_LIMIT = 1024;

/**
 * Stop reasons that mean the turn continues: the engine will step again, so
 * the footer would land in the middle of a reply. Every other reason ends it.
 */
const MID_TURN: ReadonlySet<string> = new Set(["tool_use", "pause_turn"]);

/** The reason a subagent row gives when nothing better is known. */
const NO_SPAWN_SEEN = "no spawn seen, runs on its own model";

/** Why a fork is left alone. */
const FORK = "fork keeps its parent's model";

/** Why a subagent is left alone when the person turned subagent routing off. */
const SUBAGENTS_OFF = "subagent routing off";

/** Why a resumed run is not asked about again. */
const RESUMED = "resumed, not re-asked";

/** Why a teammate the router never saw spawn is not asked about on a wake. */
const TEAMMATE_UNSEEN = "teammate whose spawn was not seen";

/** What a row says when `/jev off` is why nothing was done. */
const ROUTING_OFF = "routing off";

/** Why a main-loop turn with no text and no turn before it is left alone. */
const EMPTY_PROMPT = "empty prompt";

/** The `/jev` switches, kept by the host so a reload does not reset them. */
const SWITCHES = { plugin: "jev-router", key: "switches" } as const;

/** Each agent's routing by its id, kept by the host for the same reason. */
const AGENTS = { plugin: "jev-router", key: "agents" } as const;

/**
 * What a subagent's routing settled: the decision it runs on and the row it
 * is shown in.
 *
 * `prompt` is the prompt the spawn asked Jev about, kept on a workflow
 * agent's until its first turn starts. A run that keeps its script out of
 * SDK events gives every spawn of it one fixed placeholder for a prompt, and
 * the agent starts with the script's own; a first turn that opens with
 * something else says the spawn was routed blind, and it is asked again
 * about what it was actually given.
 */
type Routed = { decision: Decision; attempt: Attempt; prompt?: string };

/**
 * What a spawn leaves for its agent's loop to pick up: how it was routed,
 * why it was not, or that it is to be routed once its loop says what it
 * was given. A fork's loop has to find "not" as surely as a routed one finds
 * its decision, or its first turn would be taken for a loop nobody spawned and
 * Jev asked about it after all.
 *
 * `deferred` is a workflow agent whose spawn carried a prompt another spawn
 * of its run already had: the placeholder, or a prompt the script really
 * gave twice. Asking Jev about a placeholder routes on nothing, so the
 * question waits for the loop's first text.
 */
type Handoff = Routed | { skipped: string } | { deferred: SpawnLike };

/**
 * A handoff as it waits on its prompt's queue, with what tells it from its
 * siblings': the type and description its spawn gave (which `$.agent.list()`
 * shows for the agent too), and the model the spawn sent it down on (which
 * its steps arrive on).
 */
type Queued = {
  handoff: Handoff;
  type: string;
  description: string;
  model?: string;
};

/** What a claim answers when the loop cannot tell its entry from another. */
const PENDING = Symbol("pending");

/**
 * Whether two handoffs would leave their agents running alike: the same
 * family at the same effort, or left alone for the same reason, or both
 * waiting to be asked. Only those may be handed to whichever sibling's
 * loop asks first.
 */
function sameAs(a: Handoff, b: Handoff): boolean {
  if ("skipped" in a || "skipped" in b) {
    return "skipped" in a && "skipped" in b && a.skipped === b.skipped;
  }
  if ("deferred" in a || "deferred" in b) {
    return "deferred" in a && "deferred" in b;
  }
  return (
    a.decision.tier === b.decision.tier &&
    a.decision.effort === b.decision.effort
  );
}

type EnvReader = {
  env: { get: (name: string) => Promise<string | undefined> };
};

/**
 * An env var's read, as undefined when it cannot be read. Reading the
 * environment is not worth a turn: a failure means "not set".
 *
 * It takes the read rather than the name because every `$.env.get` must
 * name its variable literally: the engine lists the variables a module
 * reads from those calls, and refuses a module that reads one by a name it
 * cannot see.
 */
function quietly(
  read: Promise<string | undefined>,
): Promise<string | undefined> {
  return read.catch(() => undefined);
}

/** The provider the env names, read fresh so a key set mid-session counts. */
async function providerFrom($: EnvReader): Promise<ProviderResult> {
  return providerOf({
    TYPESAFE_API_KEY: await quietly($.env.get("TYPESAFE_API_KEY")),
    AI_GATEWAY_API_KEY: await quietly($.env.get("AI_GATEWAY_API_KEY")),
    JEV_ROUTER_PROVIDER: await quietly($.env.get("JEV_ROUTER_PROVIDER")),
    TYPESAFE_BASE_URL: await quietly($.env.get("TYPESAFE_BASE_URL")),
  });
}

/**
 * The settings in force, and where each came from: the env vars, read
 * fresh like the provider so an export mid-session counts, over the
 * plugin's options, which are fixed for this activation (a change to them
 * reloads the plugin and `register` runs again with the new ones).
 *
 * The ladder comes with them: the bands every effort is clamped into and
 * the default a fallback runs on, built by `ladderOf` from the same read,
 * so a band exported mid-session reaches the next decision and the next
 * step alike.
 *
 * The eleven names are spelled out rather than looped over `CONFIG_ENV_KEYS`,
 * since each read must name its variable literally (see `quietly`); a test
 * holds this list to that one.
 */
async function settingsFrom(
  $: EnvReader,
  options: PluginOptions | undefined,
): Promise<{ config: RouterSettings; sources: ConfigSources; ladder: Ladder }> {
  const env: Record<string, string | undefined> = {
    JEV_ROUTER_FABLE: await quietly($.env.get("JEV_ROUTER_FABLE")),
    JEV_ROUTER_FABLE_CONFIDENCE: await quietly(
      $.env.get("JEV_ROUTER_FABLE_CONFIDENCE"),
    ),
    JEV_ROUTER_MIN_CONFIDENCE: await quietly(
      $.env.get("JEV_ROUTER_MIN_CONFIDENCE"),
    ),
    JEV_ROUTER_SUBAGENTS: await quietly($.env.get("JEV_ROUTER_SUBAGENTS")),
    JEV_ROUTER_DEFAULT_MODEL: await quietly(
      $.env.get("JEV_ROUTER_DEFAULT_MODEL"),
    ),
    JEV_ROUTER_DEFAULT_EFFORT: await quietly(
      $.env.get("JEV_ROUTER_DEFAULT_EFFORT"),
    ),
    JEV_ROUTER_HAIKU_EFFORT: await quietly(
      $.env.get("JEV_ROUTER_HAIKU_EFFORT"),
    ),
    JEV_ROUTER_SONNET_EFFORT: await quietly(
      $.env.get("JEV_ROUTER_SONNET_EFFORT"),
    ),
    JEV_ROUTER_OPUS_EFFORT: await quietly($.env.get("JEV_ROUTER_OPUS_EFFORT")),
    JEV_ROUTER_FABLE_EFFORT: await quietly(
      $.env.get("JEV_ROUTER_FABLE_EFFORT"),
    ),
    JEV_ROUTER_CONTEXT: await quietly($.env.get("JEV_ROUTER_CONTEXT")),
  };
  const config = configOf(options, env);
  return {
    config,
    sources: configSourcesOf(options, env),
    ladder: ladderOf(config),
  };
}

/**
 * The families Jev is offered, after the Fable setting and
 * `JEV_ROUTER_EXCLUDE`. The ladder's default is never excluded, nor Opus
 * (`excludedTiers` says why).
 */
async function offeredFrom(
  $: EnvReader,
  config: RouterSettings,
): Promise<Tier[]> {
  const ladder = ladderOf(config);
  return offeredTiers(
    excludedTiers(await quietly($.env.get("JEV_ROUTER_EXCLUDE")), ladder),
    config.fable,
    ladder,
  );
}

/** An agent as the session's list shows it, as far as the router reads it. */
type AgentRow = {
  id: string;
  type: string;
  description: string;
  teammateId?: string;
};

type Lister = {
  agent: { list: () => Promise<readonly AgentRow[]> };
};

/**
 * The session's list row for a loop, or undefined. A workflow's agents and
 * the engine's own forks have none; a forked skill has one; a teammate's
 * carries its `teammateId`.
 */
async function rowOf(
  $: Lister,
  agentId: string,
): Promise<AgentRow | undefined> {
  const rows = await $.agent.list().catch(() => []);
  return rows.find((r) => r.id === agentId);
}

/**
 * Names the subagent a step runs in, from the session's agent list. A row may
 * not be there yet for a loop that only just started; then the id stands in,
 * which still says "not the main loop", the part that matters.
 */
async function agentTagOf($: Lister, agentId: string): Promise<AgentTag> {
  const row = await rowOf($, agentId);
  return row ? { type: row.type, label: row.description } : { label: agentId };
}

/**
 * The prompt a subagent's loop began with: its first user message, which is
 * the Agent call's prompt as the spawn hooks left it. Undefined when the
 * session cannot read that loop or it has no user message yet.
 */
async function firstPromptOf(
  $: {
    session: {
      messages: (args: {
        agentId: string;
      }) => Promise<
        readonly { role: string; text: string }[] | { deny: string }
      >;
    };
  },
  agentId: string,
): Promise<string | undefined> {
  const rows = await $.session.messages({ agentId }).catch(() => null);
  if (rows === null || !Array.isArray(rows)) return undefined;
  return rows.find((r) => r.role === "user")?.text;
}

/**
 * The longest a turn waits on reading the session (its transcript, its
 * directory) before it asks Jev with the request alone. Both are reads of
 * what the engine already holds and come back at once; this only stops a
 * read that never answers from holding the turn up with it.
 */
const SESSION_READ_MS = 250;

/** What reading the main loop's transcript needs of `$`. */
type SessionReader = {
  session: {
    messages: () => Promise<readonly TranscriptRow[]>;
    cwd: () => Promise<string>;
  };
  clock: { sleep: (ms: number) => Promise<unknown> };
};

/**
 * What one read of the session came to, or undefined when it threw (at
 * once or later) or did not answer within `SESSION_READ_MS`. Context is
 * worth having and never worth a turn.
 */
async function quickly<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<unknown>,
): Promise<T | undefined> {
  try {
    return await Promise.race([
      read(),
      sleep(SESSION_READ_MS).then(() => undefined),
    ]);
  } catch {
    return undefined;
  }
}

/**
 * The state of a main-loop turn's question (`turnStateOf`): the request,
 * and what the main loop's transcript says around it. One read of the
 * transcript and one of the directory, side by side; if either fails, the
 * fields it feeds are left out, and if building the state fails at all,
 * the request goes alone. Jev is asked either way.
 *
 * Under the "request" context setting neither is read: the state is the
 * request alone, so nothing the transcript holds can reach Jev, not even
 * by a field built from it by mistake.
 */
async function turnStateFrom(
  $: SessionReader,
  request: string,
  context: ContextMode,
): Promise<TurnState> {
  if (context === "request") {
    try {
      return turnStateOf({ request });
    } catch {
      return { request: request.trim() };
    }
  }
  const sleep = (ms: number) => $.clock.sleep(ms);
  const [messages, cwd] = await Promise.all([
    quickly(() => $.session.messages(), sleep),
    quickly(() => $.session.cwd(), sleep),
  ]);
  try {
    return turnStateOf({
      request,
      ...(Array.isArray(messages) ? { messages } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
    });
  } catch {
    return { request: request.trim() };
  }
}

/** A provider that can be asked through. */
type Provider = Extract<ProviderResult, { ok: true }>;

/** What asking Jev needs of `$`: the env, the network and the clock. */
type Asker = EnvReader & {
  http: { fetch: Parameters<typeof askJev>[0]["fetch"] };
  clock: { sleep: (ms: number) => Promise<unknown> };
};

/**
 * Asks Jev, and turns anything thrown on the way into a failed call: the
 * router never stops a turn or a spawn, it only declines to route it.
 */
async function ask(
  $: Asker,
  args: {
    provider: Provider;
    state: JevState;
    offered: readonly Tier[];
    asking: "turn" | "subagent";
    fable: FableMode;
    ladder: Ladder;
  },
): Promise<JevResult> {
  try {
    return await askJev({
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms) => $.clock.sleep(ms),
      timeoutMs: timeoutOf(await quietly($.env.get("JEV_ROUTER_TIMEOUT_MS"))),
      ...args,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `router error: ${detail}`, ms: 0 };
  }
}

/**
 * What the developer last typed to the main loop, for a spawn whose brief
 * may be thin (`briefStateOf`): the router's copy, kept at each typed
 * `turn.start`.
 *
 * That copy lives in this copy of the module, and a change to any setting
 * reloads it, so a spawn in the same turn as a reload (or on a turn a
 * notification woke) would find none and send a thin brief alone. Then,
 * and only for a brief short enough to need it, the transcript is read
 * once (`quickly`, so a slow or failing read costs a spawn nothing) and
 * what it says is kept as the copy. A fan-out of forty thin briefs shares
 * that one read, and a full brief never causes one.
 *
 * Under the "request" context setting there is none, whatever the brief:
 * the developer's words to the main loop are the conversation, which that
 * setting keeps on the machine, and the brief is the task itself.
 */
async function parentRequestOf(
  r: Router,
  $: SessionReader,
  prompt: string,
  context: ContextMode,
): Promise<string | null> {
  if (context === "request") return null;
  if (r.request !== null || prompt.trim().length >= THIN_BRIEF_CHARS) {
    return r.request;
  }
  r.requestRead ??= (async () => {
    const rows = await quickly(
      () => $.session.messages(),
      (ms) => $.clock.sleep(ms),
    );
    try {
      return Array.isArray(rows) ? lastTypedRequestOf(rows) : null;
    } catch {
      return null;
    }
  })();
  const found = await r.requestRead;
  r.request ??= found;
  return r.request;
}

/**
 * One subagent's routing from what describes it. The caller records the row.
 *
 * `parentRequest` is what the developer last typed to the main loop, which
 * `briefStateOf` shows beside a thin brief only. It is the router's copy,
 * kept at the main loop's `turn.start` (`parentRequestOf`): a spawn reads
 * no transcript while there is one, so a workflow fanning out to forty
 * agents costs no read at all.
 */
async function routeSpawn(
  $: Asker,
  provider: Provider,
  spawn: SpawnLike,
  config: RouterSettings,
  parentRequest: string | null,
): Promise<Routed> {
  const offered = await offeredFrom($, config);
  const result = await ask($, {
    provider,
    state: briefStateOf(
      {
        prompt: spawn.prompt,
        description: spawn.description,
        subagentType: spawn.subagentType,
        workflow: spawn.workflow ?? false,
      },
      parentRequest,
    ),
    offered,
    asking: "subagent",
    fable: config.fable,
    ladder: ladderOf(config),
  });
  // No stickiness: a subagent starts cold whichever model it lands on.
  const attempt = spawnAttemptOf(spawn, result, offered, routeOf(config));
  return { decision: attempt.decision, attempt };
}

/**
 * The request as the Fable guard lets it go: on the guard's model
 * (`guardTargetOf`: the ladder's default, lifted to Opus when it sits
 * below) when the setting refuses the one it names, as it came otherwise.
 */
function guarded<E extends { model?: string }>(
  e: E,
  config: RouterSettings,
): E {
  return isForbiddenModel(e.model, config.fable)
    ? { ...e, model: modelOf(guardTargetOf(ladderOf(config)).tier) }
    : e;
}

/**
 * A step nobody decided, held to the bands: the effort it came with,
 * clamped into the band of the family its model belongs to. Forks,
 * resumes, teammates whose spawn was not seen, a first turn with nothing
 * to ask about and steps the engine moved to a fallback model all go out
 * on the model they came with; without this they would go at the
 * session's effort too, and a session at /effort low would run Haiku at
 * low, which no band allows. Only the effort moves, so a fork keeps the
 * model whose cache it inherited. An effort given as a number, or none (a
 * model that takes none), and a model the ladder does not know, are left
 * as they came: there is no band to read them against.
 */
function banded<E extends { model: string; effort?: string | number }>(
  e: E,
  ladder: Ladder,
): E {
  const family = familyOfModel(e.model);
  if (family === undefined || !isEffort(e.effort)) return e;
  const clamped = clampEffort(family, e.effort, ladder);
  return clamped === e.effort ? e : { ...e, effort: clamped };
}

/**
 * The switches as the host kept them, or undefined: never written, or not
 * readable (an engine with no `$.state`). What is kept there spares a
 * reload, and losing it costs no more than the reload would have.
 */
async function switchesHeld(
  $: StateDollar,
): Promise<Partial<JevRouterSwitches> | undefined> {
  try {
    const { value } = await $.state.get(SWITCHES);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

async function holdSwitches(
  $: StateDollar,
  switches: JevRouterSwitches,
): Promise<void> {
  try {
    await $.state.set(SWITCHES, switches);
  } catch {
    // Kept in memory all the same; only a reload would lose it.
  }
}

/** One agent's routing as the host kept it, unchecked. */
async function agentHeld(
  $: StateDollar,
  agentId: string,
): Promise<JevRouterAgent | undefined> {
  try {
    return (await $.state.get({ ...AGENTS, id: agentId })).value;
  } catch {
    return undefined;
  }
}

async function holdAgent(
  $: StateDollar,
  agentId: string,
  kept: JevRouterAgent,
): Promise<void> {
  try {
    await $.state.set({ ...AGENTS, id: agentId }, kept);
  } catch {
    // As for the switches.
  }
}

/**
 * An agent's routing as the host kept it, or undefined when what is there
 * is not something this code wrote: an older copy's, or nothing.
 *
 * The decision goes through `revivedDecision`, which reads one an older
 * copy kept in the fixed-rung shape (`opus-high`, `sonnet-medium`) as the
 * family and effort it ran on. Without that, the first reload after an
 * upgrade would drop every agent's routing, and each would be asked about
 * again on whatever one-line message woke it.
 *
 * The decision kept is the one as stored, its effort not clamped: it is
 * what gets written back, and a copy clamped into a band narrowed at this
 * reload and stored again would keep the agent narrowed after the band
 * was widened. Each step clamps it into the bands of its own moment. The
 * attempt's copy, which only the row reads, is the one clamped into
 * `ladder`, so the row says what the agent runs on now.
 */
function agentFrom(
  kept: JevRouterAgent | undefined,
  ladder: Ladder,
): Routed | { skipped: string } | undefined {
  if (typeof kept !== "object" || kept === null) return undefined;
  if ("skipped" in kept) {
    return typeof kept.skipped === "string"
      ? { skipped: kept.skipped }
      : undefined;
  }
  const decision = revivedDecision(kept.decision, ladder, { clamp: false });
  if (
    decision === null ||
    typeof kept.attempt !== "object" ||
    kept.attempt === null
  ) {
    return undefined;
  }
  const attempt = { ...kept.attempt } as unknown as Attempt;
  if ("decision" in attempt) {
    attempt.decision = revivedDecision(decision, ladder) ?? decision;
  }
  return {
    decision,
    attempt,
    ...(typeof kept.prompt === "string" ? { prompt: kept.prompt } : {}),
  };
}

/** The routing as the host keeps it: plain data. */
function keptOf(routed: Routed): JevRouterAgent {
  return {
    decision: routed.decision,
    attempt: routed.attempt,
    ...(routed.prompt !== undefined ? { prompt: routed.prompt } : {}),
  };
}

/** A routing with the prompt its spawn asked about let go of. */
function settled(routed: Routed): Routed {
  return { decision: routed.decision, attempt: routed.attempt };
}

/**
 * Everything one activation of the router keeps. A plain object the
 * functions below take, rather than variables `register` closes over: the
 * engine only lets `$` be passed to functions declared at the top of the
 * module, and most of what touches this state needs `$` as well.
 */
type Router = {
  /** turnId → the decision its steps run on. */
  decisions: Map<string, Decision>;
  /**
   * Turns whose reply has yet to open with its route line. The line itself
   * is built at the first text chunk, not at the turn's start: by then the
   * step has said which loop the turn runs in, which the line names.
   * Main-loop turns only.
   */
  pending: Set<string>;
  attempts: Attempt[];
  /**
   * turnId → its attempt, so each step's `stop` chunk can add what the API
   * reported to the right turn. The same objects as in `attempts`.
   */
  byTurn: Map<string, Attempt>;
  /**
   * turnId → the model its first step arrived on. A later step of the same
   * turn that names another is one the engine moved to a fallback model
   * (a refusal, an overload): that request goes on the model the engine
   * resolved, under the Fable guard and the bands, rather than back to the
   * model that just failed.
   */
  firstModels: Map<string, string | undefined>;
  /**
   * turnId → the text a subagent's turn began with, for a turn whose
   * `turn.start` could not tell its handoff from a sibling's. Its steps
   * look again, with the model they arrived on to tell them apart.
   */
  unclaimed: Map<string, string>;
  /**
   * agentId → what its spawn settled, once the spawn said the id. Kept past
   * the agent's turn, since a loop woken by a message runs another turn on
   * the same id; most recently used last, so the leak guard drops the
   * agents nobody has heard from in longest. Written through to `$.state`.
   */
  byAgent: Map<string, Routed>;
  /**
   * The prompt a spawn passed on → what it left for its agent's loop,
   * oldest first, pushed before the spawn goes down the chain. A subagent's
   * first `turn.start` or `turn.step` can arrive before `next(e)` answers
   * with its id: the loop starts inside the call. Its prompt is the one
   * thing both sides know by then.
   *
   * A queue, and one-shot: each loop takes one entry, and a spawn takes back
   * an entry nobody took when it answers. Parallel workflow judges handed
   * the same prompt each get their own, and a fork that later starts with a
   * matching prompt finds nothing to inherit.
   */
  handoffs: Map<string, Queued[]>;
  /** prompt → spawns handed off with it whose `next` has not answered yet. */
  open: Map<string, number>;
  /** agentId → why it was left unrouted on purpose: a fork, a resume. */
  unrouted: Map<string, string>;
  /** agentId → the spawn of a deferred workflow agent, until its loop speaks. */
  waiting: Map<string, SpawnLike>;
  /** Agents already looked for in `$.state`, so each costs one read at most. */
  looked: Set<string>;
  /** Agents whose routing changed since it was last written to `$.state`. */
  dirty: Set<string>;
  /** `runId` + prompt → how many spawns of that run have carried it. */
  runPrompts: Map<string, number>;
  latest: Decision | null;
  /**
   * What the developer last typed to the main loop, kept at its
   * `turn.start` for the subagents it goes on to start: a thin brief is
   * shown beside it (`briefStateOf`). Null before the first typed turn; a
   * notification, a teammate's message or a continuation is nobody typing
   * (`isEngineText`), and leaves it be. Null again after a reload, until
   * `parentRequestOf` finds it in the transcript or the developer types.
   */
  request: string | null;
  /**
   * The share of Jev's probability that must say the cheaper model is
   * enough before a switch down, or null when switches are free. The
   * env vars are the session's starting value; `/jev sticky` overrides them
   * from then on, so retuning does not mean restarting the session.
   */
  sticky: number | null;
  /** What the last main-loop turn ran on; what a shaky switch is held to. */
  running: Decision | null;
  enabled: boolean;
  announce: boolean;
  /** Whether the last look found a key; what the footer label goes by. */
  keyed: boolean;
  surface: string | null;
  /** The switches' read back from `$.state`, once: true when there were some. */
  restoring: Promise<boolean> | null;
  /**
   * The one read of the transcript for `request` when a thin brief needs it
   * and this copy of the module has seen no typed turn (`parentRequestOf`).
   */
  requestRead: Promise<string | null> | null;
};

function routerOf(): Router {
  return {
    decisions: new Map(),
    pending: new Set(),
    attempts: [],
    byTurn: new Map(),
    firstModels: new Map(),
    unclaimed: new Map(),
    byAgent: new Map(),
    handoffs: new Map(),
    open: new Map(),
    unrouted: new Map(),
    waiting: new Map(),
    looked: new Set(),
    dirty: new Set(),
    runPrompts: new Map(),
    latest: null,
    request: null,
    sticky: null,
    running: null,
    enabled: true,
    announce: true,
    keyed: true,
    surface: null,
    restoring: null,
    requestRead: null,
  };
}

function trim(map: Map<string, unknown>): void {
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function trimSet(set: Set<string>): void {
  while (set.size > CACHE_LIMIT) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

/**
 * Reads the switches back from the host, the first time any hook runs in
 * this copy of the module. After a reload that is what keeps `/jev off`
 * off, and `/jev quiet` and `/jev sticky` as they were set.
 *
 * What the main loop was running on comes back with them. A change to any
 * setting is a reload, and without it the turn after one would have
 * nothing to hold to (a shaky switch down would go through and pay a cold
 * cache) and a continuation nothing to carry on from. It is read back as
 * kept, not clamped: the hold and the step clamp it into the bands of
 * their own moment, as they do any decision.
 */
function restore(r: Router, $: StateDollar): Promise<boolean> {
  r.restoring ??= (async () => {
    const kept = await switchesHeld($);
    if (kept === undefined) return false;
    if (typeof kept.enabled === "boolean") r.enabled = kept.enabled;
    if (typeof kept.announce === "boolean") r.announce = kept.announce;
    if (
      kept.sticky === null ||
      (typeof kept.sticky === "number" && kept.sticky > 0 && kept.sticky < 1)
    ) {
      r.sticky = kept.sticky;
    }
    if (kept.running !== undefined) {
      r.running =
        kept.running === null
          ? null
          : revivedDecision(kept.running, DEFAULT_LADDER, { clamp: false });
    }
    return true;
  })();
  return r.restoring;
}

function keepSwitches(r: Router, $: StateDollar): Promise<void> {
  return holdSwitches($, {
    enabled: r.enabled,
    announce: r.announce,
    sticky: r.sticky,
    running: r.running,
  });
}

/** Writes what changed about agents to the host. */
async function flush(r: Router, $: StateDollar): Promise<void> {
  const ids = [...r.dirty];
  r.dirty.clear();
  for (const id of ids) {
    const routed = r.byAgent.get(id);
    const skipped = r.unrouted.get(id);
    if (routed !== undefined) await holdAgent($, id, keptOf(routed));
    else if (skipped !== undefined) await holdAgent($, id, { skipped });
  }
}

/**
 * Whether the router acts at all, and the provider it asks through when it
 * does. `/jev off` and no key are the same answer, and the only one every
 * hook needs before anything else: off, and why.
 */
async function routing(
  r: Router,
  $: EnvReader & StateDollar,
): Promise<{ provider: Provider } | { off: string }> {
  await restore(r, $);
  if (!r.enabled) return { off: ROUTING_OFF };
  const provider = await providerFrom($);
  r.keyed = provider.ok;
  return provider.ok ? { provider } : { off: provider.reason };
}

function record(r: Router, attempt: Attempt): void {
  r.attempts.unshift(attempt);
  r.attempts.length = Math.min(r.attempts.length, HISTORY_LIMIT);
}

/**
 * Whether anything draws this session's replies. An empty list is a plain
 * `claude -p` run or an SDK host with no surface attached: its result is
 * the reply's last text block, so a footer there would replace the answer
 * and a route line would land in a script's output. Asked per step, since a
 * surface may attach after the session starts; a call that fails counts as
 * drawn, which is how this behaved before.
 */
async function drawsReplies($: {
  session: { surfaces: () => Promise<readonly string[]> };
}): Promise<boolean> {
  try {
    return (await $.session.surfaces()).length > 0;
  } catch {
    return true;
  }
}

/** Ties a turn to a decision and the row its usage is added to. */
function bind(r: Router, turnId: string, routed: Routed): void {
  r.decisions.set(turnId, routed.decision);
  trim(r.decisions);
  r.byTurn.set(turnId, routed.attempt);
  trim(r.byTurn);
}

/** Lets go of a finished turn: nothing steps in it again. */
function forget(r: Router, turnId: string): void {
  r.decisions.delete(turnId);
  r.byTurn.delete(turnId);
  r.pending.delete(turnId);
  r.firstModels.delete(turnId);
  r.unclaimed.delete(turnId);
}

function remember(r: Router, agentId: string, routed: Routed): void {
  r.byAgent.delete(agentId);
  r.byAgent.set(agentId, routed);
  trim(r.byAgent);
  r.dirty.add(agentId);
}

function leaveUnrouted(r: Router, agentId: string, reason: string): void {
  r.unrouted.set(agentId, reason);
  trim(r.unrouted);
  r.dirty.add(agentId);
}

/** Whether anything at all has been said about this agent yet. */
function known(r: Router, agentId: string): boolean {
  return (
    r.byAgent.has(agentId) || r.unrouted.has(agentId) || r.waiting.has(agentId)
  );
}

/**
 * An agent's routing, moved to the back so the leak guard spares it, or
 * read back from the host when this copy of the module has not seen it: a
 * reload empties every map here, and a teammate routed before it must not
 * be asked about again on the message that wakes it. What is read back is
 * kept as stored; only its row is clamped into `ladder`'s bands (see
 * `agentFrom`).
 */
async function recall(
  r: Router,
  $: StateDollar,
  agentId: string,
  ladder: Ladder,
): Promise<Routed | undefined> {
  const routed = r.byAgent.get(agentId);
  if (routed !== undefined) {
    r.byAgent.delete(agentId);
    r.byAgent.set(agentId, routed);
    return routed;
  }
  if (known(r, agentId) || r.looked.has(agentId)) return undefined;
  r.looked.add(agentId);
  trimSet(r.looked);
  const kept = agentFrom(await agentHeld($, agentId), ladder);
  if (kept === undefined) return undefined;
  if ("skipped" in kept) {
    r.unrouted.set(agentId, kept.skipped);
    trim(r.unrouted);
    return undefined;
  }
  r.byAgent.set(agentId, kept);
  trim(r.byAgent);
  return kept;
}

/** Ties an agent to a handoff: its routing, why it has none, or a wait. */
function settle(
  r: Router,
  agentId: string,
  handoff: Handoff,
): Routed | undefined {
  if ("skipped" in handoff) {
    leaveUnrouted(r, agentId, handoff.skipped);
    return undefined;
  }
  if ("deferred" in handoff) {
    r.waiting.set(agentId, handoff.deferred);
    trim(r.waiting);
    return undefined;
  }
  remember(r, agentId, handoff);
  return handoff;
}

/** Takes one entry off its prompt's queue, saying whether it was there. */
function take(r: Router, prompt: string, queued: Queued): boolean {
  const queue = r.handoffs.get(prompt);
  const at = queue?.indexOf(queued) ?? -1;
  if (queue === undefined || at < 0) return false;
  queue.splice(at, 1);
  if (queue.length === 0) r.handoffs.delete(prompt);
  return true;
}

/**
 * Takes the handoff left for a prompt that belongs to the agent whose loop
 * began with it, and ties the agent to it. A routed one is returned; one
 * left unrouted or deferred is noted as such, and nothing is returned.
 *
 * Entries for one prompt are not interchangeable in general: two spawns can
 * share a prompt and differ in type, description or fork, and Jev answers
 * each differently. So the queue is narrowed first by what the agent shows:
 * its list row's type and description, and the model its step arrived on,
 * which its spawn chose. What is left may be handed to this loop only if
 * every entry would run it alike; otherwise `strict` (at `turn.start`)
 * answers PENDING, and the agent is bound by its id when its spawn answers,
 * or by its step's model before that. A step, which must send something
 * now, takes the oldest of what is left.
 */
function claim(
  r: Router,
  prompt: string,
  agentId: string,
  hint: { row?: AgentRow; model?: string },
  strict: boolean,
): Routed | undefined | typeof PENDING {
  let pool = r.handoffs.get(prompt) ?? [];
  const { row, model } = hint;
  if (row !== undefined) {
    const same = pool.filter(
      (q) => q.type === row.type && q.description === row.description,
    );
    if (same.length > 0) pool = same;
  }
  if (model !== undefined) {
    const same = pool.filter((q) => q.model === model);
    if (same.length > 0) pool = same;
  }
  const first = pool[0];
  if (first === undefined) return undefined;
  if (strict && !pool.every((q) => sameAs(q.handoff, first.handoff))) {
    return PENDING;
  }
  take(r, prompt, first);
  return settle(r, agentId, first.handoff);
}

/** Whether any spawn left an entry to be routed at its loop's first text. */
function hasDeferred(r: Router): boolean {
  for (const queue of r.handoffs.values()) {
    if (queue.some((q) => "deferred" in q.handoff)) return true;
  }
  return false;
}

/**
 * A deferred workflow agent's entry, for a loop no prompt matched: a
 * placeholder run's agents start with the script's own prompt, not the one
 * their spawn carried, so no queue is keyed by what they say. Every deferred
 * entry waits for the same thing, which makes the oldest as good as any.
 */
function claimDeferred(r: Router, agentId: string): void {
  for (const [prompt, queue] of r.handoffs) {
    const queued = queue.find((q) => "deferred" in q.handoff);
    if (queued !== undefined) {
      take(r, prompt, queued);
      settle(r, agentId, queued.handoff);
      return;
    }
  }
}

/**
 * Whether a workflow spawn's prompt is one an earlier spawn of its run
 * already carried: the placeholder of a run that keeps its script out of SDK
 * events, or a prompt the script really gave twice. Either way the agent's
 * own first text says more than the spawn does.
 */
function repeated(
  r: Router,
  workflow: { runId: string },
  prompt: string,
): boolean {
  const key = `${workflow.runId}\n${prompt}`;
  const seen = r.runPrompts.get(key) ?? 0;
  r.runPrompts.delete(key);
  r.runPrompts.set(key, seen + 1);
  trim(r.runPrompts);
  return seen > 0;
}

/**
 * Sends a spawn down the chain with its handoff waiting for the agent's
 * loop, then binds the agent the spawn answers with.
 *
 * A loop only takes an entry that would run it as its own would, so a
 * sibling's taking this spawn's entry leaves one just like it: the agent
 * that claimed one keeps it, and an agent that claimed none takes its own
 * entry, or, when a sibling's loop took that, the sibling's alike one. When
 * the last spawn of a prompt answers, whatever is still queued belongs to
 * nobody and goes, so a later fork with the same prompt finds nothing to
 * inherit.
 */
async function handOff<R extends { agentId?: string }>(
  r: Router,
  $: StateDollar,
  prompt: string,
  queued: Queued,
  run: () => Promise<R>,
): Promise<R> {
  const queue = r.handoffs.get(prompt) ?? [];
  queue.push(queued);
  r.handoffs.set(prompt, queue);
  r.open.set(prompt, (r.open.get(prompt) ?? 0) + 1);
  let id: string | undefined;
  try {
    const out = await run();
    id = out.agentId;
    if (id !== undefined && !known(r, id)) {
      let mine = queued.handoff;
      if (!take(r, prompt, queued)) {
        const alike = r.handoffs
          .get(prompt)
          ?.find((q) => sameAs(q.handoff, queued.handoff));
        if (alike !== undefined) {
          take(r, prompt, alike);
          mine = alike.handoff;
        }
      }
      settle(r, id, mine);
    }
    return out;
  } finally {
    // No local loop to claim it (a remote workflow agent, a refused spawn):
    // nobody ever will.
    if (id === undefined) take(r, prompt, queued);
    const left = (r.open.get(prompt) ?? 1) - 1;
    if (left > 0) {
      r.open.set(prompt, left);
    } else {
      r.open.delete(prompt);
      r.handoffs.delete(prompt);
    }
    await flush(r, $);
  }
}

/**
 * Routes a deferred workflow agent on the text its loop began with, or on
 * its spawn when that is all there is, and keeps the answer by its id.
 */
async function routeWaiting(
  r: Router,
  $: Asker & SessionReader,
  provider: Provider,
  agentId: string,
  text: string | undefined,
  config: RouterSettings,
): Promise<Routed | undefined> {
  const spawn = r.waiting.get(agentId);
  if (spawn === undefined) return undefined;
  r.waiting.delete(agentId);
  if (!config.routeSubagents) {
    leaveUnrouted(r, agentId, SUBAGENTS_OFF);
    return undefined;
  }
  const prompt =
    text !== undefined && text.trim() !== "" ? text : spawn.prompt;
  const routed = await routeSpawn(
    $,
    provider,
    { ...spawn, prompt },
    config,
    await parentRequestOf(r, $, prompt, config.context),
  );
  record(r, routed.attempt);
  remember(r, agentId, routed);
  return routed;
}

/**
 * A workflow agent's routing at its first turn, when its spawn was routed on
 * a prompt the loop does not begin with (the run's placeholder): asked
 * again, about what it was given. Otherwise the routing it had, with the
 * spawn's prompt let go of, so that no later turn compares against it.
 */
async function firstTurn(
  r: Router,
  $: Asker & SessionReader,
  provider: Provider,
  agentId: string,
  routed: Routed,
  text: string,
  config: RouterSettings,
): Promise<Routed> {
  if (routed.prompt === undefined) return routed;
  if (text.trim() === "" || text === routed.prompt || !config.routeSubagents) {
    const plain = settled(routed);
    remember(r, agentId, plain);
    return plain;
  }
  const { agent, asked } = routed.attempt;
  const again = await routeSpawn(
    $,
    provider,
    {
      prompt: text,
      description: agent?.label,
      subagentType: agent?.type,
      workflow: true,
      model: asked,
    },
    config,
    await parentRequestOf(r, $, text, config.context),
  );
  record(r, again.attempt);
  remember(r, agentId, again);
  return again;
}

/**
 * Registers the router: one Jev call per main-loop turn and one per subagent,
 * applied to every model request each makes, and announced as it happens on
 * the main loop.
 *
 * Off means off. The router acts only while it is active: `/jev on` (the
 * default) and a key to ask Jev through. With `/jev off`, or with no
 * `TYPESAFE_API_KEY` and no `AI_GATEWAY_API_KEY`, every hook passes its
 * event on as it came: no Jev call, no model or effort rewritten, no Fable
 * guard. What the person or the script asked for is what runs. Every hook
 * asks `routing` first, so there is one answer to "is it on".
 *
 * The main loop's decision is made once in `turn.start`, where the person's
 * text is, and read back in `turn.step`, which fires again after each tool
 * result. Asking per step would pay Jev's latency several times over and
 * could land two steps of one turn on different models.
 *
 * A subagent's is made once in `agent.spawn`, where its task is. That is the
 * one place a model can be set for every kind of agent the session starts:
 * the Agent tool's, a teammate's, a plugin's `$.agent.spawn`, and each
 * `agent()` a Workflow script calls. Jev's pick overrides whatever model the
 * caller named, which is the point: a workflow that pins forty agents to
 * Fable is the bill this exists to stop. The spawn cannot set effort, so the
 * decision is kept by agent and applied at each of its steps. A loop the
 * session lists that started with no spawn (a forked skill) is asked about
 * at its first `turn.start` instead, from the text it began with; a
 * teammate the router never saw spawn is not, since the text it wakes on is
 * a message, not its task.
 *
 * While active, what may run on Fable is the person's setting
 * (`options.fable`, or `JEV_ROUTER_FABLE`). Every decision goes through the
 * Fable gate, at the spawn and again at each step (the setting may have
 * changed since), and a request or spawn with no decision whose model the
 * setting refuses (a fork, a resume, a session set to Fable) is moved to the
 * default, lifted to Opus when it sits below (`guardTargetOf`). Any other
 * step with no decision keeps its model, and its effort is clamped into
 * that model's band (`banded`). A Jev call that fails, with a key there to make it, is a
 * different thing from no key: that turn falls back to the ladder's
 * default, Opus at high effort unless the person set another.
 *
 * The ladder (each family's effort band, the default model and effort) is
 * read with the other settings at every hook, so a band changed mid-session
 * reaches the next decision, and every step re-clamps the decision it runs
 * on into the bands of that moment, as it re-gates it for Fable.
 *
 * The switches and each agent's routing are kept in `$.state`, which the
 * host holds across a reload, and a change to any setting in the plugin's
 * config menu is a reload.
 *
 * Every turn's outcome is kept, because "did this do anything" is
 * unanswerable otherwise: a router that fails quietly looks exactly like one
 * that is not loaded.
 *
 * @param on the engine's registrar
 * @param options the plugin's `userConfig` values, defaults filled in;
 *   absent where the module is loaded without a manifest
 */
export function register(on: On, options?: PluginOptions) {
  const r = routerOf();

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "jev",
      description: "Jev routing: status, or `on` / `off`.",
    });
    r.surface = await $.session.surface();
    // A reload brings the switches back from the host; only a session that
    // never set them starts from the env vars, and keeps that start there.
    if (!(await restore(r, $))) {
      r.sticky = stickyOf(await quietly($.env.get("JEV_ROUTER_STICKY")))
        ? thresholdOf(await quietly($.env.get("JEV_ROUTER_STICKY_CONFIDENCE")))
        : null;
      await keepSwitches(r, $);
    }
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e) => {
    await restore(r, $);
    const arg = e.args.trim().toLowerCase();

    if (arg === "on" || arg === "off") {
      r.enabled = arg === "on";
      if (!r.enabled) r.latest = null;
      await keepSwitches(r, $);
      return { text: toggleReply(r.enabled, await providerFrom($)) };
    }

    if (arg === "quiet" || arg === "loud") {
      r.announce = arg === "loud";
      await keepSwitches(r, $);
      return { text: announceReply(r.announce) };
    }

    // `--sticky` as well as `sticky`: the flag spelling is what people reach
    // for, and refusing it would teach nothing.
    const sub = arg.replace(/^-+/, "");
    if (sub === "sticky" || sub.startsWith("sticky ")) {
      const result = stickyCommand(sub.slice("sticky".length), r.sticky);
      r.sticky = result.sticky;
      await keepSwitches(r, $);
      return { text: result.text };
    }

    const { config, sources, ladder } = await settingsFrom($, options);
    const excluded = excludedTiers(
      await quietly($.env.get("JEV_ROUTER_EXCLUDE")),
      ladder,
    );
    const provider = await providerFrom($);
    r.keyed = provider.ok;
    return {
      text: statusReport({
        enabled: r.enabled,
        surface: r.surface ?? (await $.session.surface()),
        provider,
        timeoutMs: timeoutOf(await quietly($.env.get("JEV_ROUTER_TIMEOUT_MS"))),
        sticky: r.sticky,
        config,
        sources,
        offered: offeredTiers(excluded, config.fable, ladder),
        excluded: [...excluded],
        announce: r.announce,
        attempts: r.attempts,
      }),
    };
  });

  // Every agent the session starts comes through here: the Agent tool's, a
  // teammate's, a plugin's, and each `agent()` of a Workflow script, which is
  // how a whole workflow's fan-out ends up routed one agent at a time.
  on("agent.spawn", async ($, e, next) => {
    const state = await routing(r, $);
    if ("off" in state) return next(e);
    const { config, ladder } = await settingsFrom($, options);

    // A resume continues a run that already has its model; the engine
    // ignores a changed model on one (and says so, once), so it is not
    // asked about again, nor rewritten. A run this session routed keeps its
    // decision, found by its id at its steps; one it did not is guarded
    // there.
    if (e.resume !== undefined) {
      const id = e.resume.agentId;
      if ((await recall(r, $, id, ladder)) === undefined && !known(r, id)) {
        leaveUnrouted(r, id, RESUMED);
        await flush(r, $);
      }
      return next(e);
    }

    const safe = guarded(e, config);
    const queued = (handoff: Handoff, model: string | undefined): Queued => ({
      handoff,
      type: e.subagentType,
      description: e.description,
      ...(model !== undefined ? { model } : {}),
    });

    // A fork inherits the parent's context, and the parent's cache with it.
    // Moving it to another model would throw that cache away on its first
    // request, which costs more than any cheaper model saves. The Fable guard still
    // holds, here and at its steps, which arrive on the parent's model.
    if (e.fork) {
      const handoff = queued({ skipped: FORK }, e.parentModel);
      return handOff(r, $, e.prompt, handoff, () => next(safe));
    }

    // Subagent routing off: each runs on what it was given, as if the
    // router only watched the main loop. Its loop must still find that out,
    // or its first turn would be asked about as one nobody spawned.
    if (!config.routeSubagents) {
      const handoff = queued({ skipped: SUBAGENTS_OFF }, safe.model);
      return handOff(r, $, e.prompt, handoff, () => next(safe));
    }

    const spawn: SpawnLike = {
      prompt: e.prompt,
      description: e.description,
      subagentType: e.subagentType,
      workflow: e.workflow !== undefined,
      model: e.model,
    };

    // A prompt its run has already spawned with: most likely the run's
    // placeholder, which says nothing about the task. Asked about at the
    // agent's first turn instead, from the prompt it actually got.
    if (e.workflow !== undefined && repeated(r, e.workflow, e.prompt)) {
      const handoff = queued({ deferred: spawn }, safe.model);
      return handOff(r, $, e.prompt, handoff, () => next(safe));
    }

    const routed = await routeSpawn(
      $,
      state.provider,
      spawn,
      config,
      await parentRequestOf(r, $, spawn.prompt, config.context),
    );
    record(r, routed.attempt);
    if (e.workflow !== undefined) routed.prompt = e.prompt;

    // Before `next`, inside `handOff`: the agent's loop starts inside that
    // call, and its first turn can arrive before the call answers with the
    // id. This overrides whatever the caller named. Effort cannot be set
    // here; the agent's steps get it, found by the id or the prompt.
    const model = routed.decision.model;
    return handOff(r, $, e.prompt, queued(routed, model), () =>
      next({ ...e, model }),
    );
  });

  on("turn.start", async ($, e, next) => {
    const state = await routing(r, $);
    if ("off" in state) return next(e);
    const { config, ladder } = await settingsFrom($, options);

    // A subagent's run: its spawn already asked Jev about its task, so this
    // only ties the turn to that answer. Nothing is announced; the reply is a
    // tool result its parent reads.
    if (e.agentId !== undefined) {
      const id = e.agentId;
      // The list is read once at most, and only when something turns on it.
      let listed: AgentRow | undefined;
      let read = false;

      let routed = await recall(r, $, id, ladder);
      if (routed === undefined && !known(r, id)) {
        // Siblings waiting on one prompt: the row tells their entries apart
        // (and their rows, so each one's usage lands on its own).
        if ((r.handoffs.get(e.text)?.length ?? 0) > 1) {
          listed = await rowOf($, id);
          read = true;
        }
        const got = claim(
          r,
          e.text,
          id,
          listed !== undefined ? { row: listed } : {},
          true,
        );
        if (got === PENDING) {
          // Siblings that would run differently, and nothing yet to tell
          // which is this one's. Its spawn's answer will say, or its step.
          r.unclaimed.set(e.turnId, e.text);
          trim(r.unclaimed);
          return next(e);
        }
        routed = got;
      }

      // A workflow agent of a placeholder run: no list row, and a text no
      // queue is keyed by.
      if (routed === undefined && !known(r, id) && hasDeferred(r)) {
        if (!read) listed = await rowOf($, id);
        read = true;
        if (listed === undefined) claimDeferred(r, id);
      }

      if (routed === undefined && r.waiting.has(id)) {
        routed = await routeWaiting(r, $, state.provider, id, e.text, config);
      } else if (routed !== undefined) {
        routed = await firstTurn(
          r,
          $,
          state.provider,
          id,
          routed,
          e.text,
          config,
        );
      }

      // A loop no spawn told us about. One the session lists as a subagent
      // (a forked skill) began with its task, so it is asked about here,
      // once, and the answer kept by its id. A teammate's text is the
      // message that woke it, not its task, and a loop the list does not
      // name at all (a workflow agent's retry, an engine fork) has nothing
      // describing what it does: neither is asked about, and their steps
      // run on what they were given, under the Fable guard.
      if (routed === undefined && !known(r, id) && e.text.trim() !== "") {
        if (!read) listed = await rowOf($, id);
        if (listed !== undefined && listed.teammateId !== undefined) {
          leaveUnrouted(r, id, TEAMMATE_UNSEEN);
        } else if (listed !== undefined && !config.routeSubagents) {
          leaveUnrouted(r, id, SUBAGENTS_OFF);
        } else if (listed !== undefined) {
          routed = await routeSpawn(
            $,
            state.provider,
            {
              prompt: e.text,
              description: listed.description,
              subagentType: listed.type,
            },
            config,
            await parentRequestOf(r, $, e.text, config.context),
          );
          record(r, routed.attempt);
          remember(r, id, routed);
        }
      }

      if (routed !== undefined) bind(r, e.turnId, routed);
      await flush(r, $);
      return next(e);
    }

    // One place where the turn's outcome is settled, so the report and the
    // announcement can never disagree about what happened. A failed call is
    // settled there too, onto the ladder's default: Opus at high effort
    // unless the person set another.
    let attempt: Attempt;
    if (e.text.trim() === "") {
      // A continuation: nothing to ask about, and the work is what the last
      // turn was doing. It runs on what that ran on, and the hold is left
      // as it was; with no last turn, on what it was given.
      if (r.running !== null) {
        const continued = continuedAttemptOf(r.running);
        r.decisions.set(e.turnId, continued.decision);
        trim(r.decisions);
        attempt = continued;
      } else {
        attempt = unroutedAttemptOf(e.text, EMPTY_PROMPT);
      }
    } else {
      // What Jev reads is the request with what surrounds it, as named
      // fields; the row keeps the text a person reads. A notification's
      // request is its summary, the same words its row shows.
      const notice = notificationOf(e.text);
      if (!isEngineText(e.text)) r.request = e.text;
      const offered = await offeredFrom($, config);
      const result = await ask($, {
        provider: state.provider,
        state: await turnStateFrom($, notice ?? e.text, config.context),
        offered,
        asking: "turn",
        fable: config.fable,
        ladder,
      });
      const routed = attemptOf(e.text, result, offered, {
        ...routeOf(config),
        sticky: r.sticky,
        running: r.running,
      });
      r.decisions.set(e.turnId, routed.decision);
      trim(r.decisions);
      r.latest = routed.decision;
      // What the next turn holds to is what is actually running, which on a
      // held turn is the previous model, and on a fallback the default.
      r.running = routed.decision;
      await keepSwitches(r, $);
      attempt = routed;
    }
    record(r, attempt);
    r.byTurn.set(e.turnId, attempt);
    trim(r.byTurn);

    // The line goes into the reply's own text, in turn.step below. Render
    // hooks and $.ui.log both drew nothing in the desktop app; the model's
    // text is the one channel that reaches every surface.
    if (r.announce) {
      r.pending.add(e.turnId);
      trimSet(r.pending);
    }

    return next(e);
  });

  // turn.step streams, so it is an async generator. The model rewrite goes
  // down in `e`; the label comes back up in the first text chunk of the turn,
  // and the `stop` chunk's usage, which names the model the API says answered,
  // is kept on the turn. That is the check on the rewrite: the route line is
  // what was asked for, /jev shows what was got.
  //
  // Text chunks concatenate per block, so prefixing the first one puts the
  // line at the top of the reply. This is the recorded text too, so the model
  // sees its past replies open with the line; that is the price of a marker
  // that reaches a surface which draws neither render sites nor ui.log.
  on("turn.step", async function* ($, e, next) {
    const state = await routing(r, $);
    let decision = r.decisions.get(e.turnId);
    let attempt = r.byTurn.get(e.turnId);
    const settings =
      "provider" in state ? await settingsFrom($, options) : null;
    const config = settings?.config ?? null;
    const ladder = settings?.ladder ?? DEFAULT_LADDER;

    // A subagent's step with no turn bound yet: its turn.start did not fire
    // (an older engine, probed live, sent none), fired before routing was
    // on, or could not tell its handoff from a sibling's. Its spawn's answer
    // is found by its id, or, when the spawn has not answered yet, by the
    // prompt its loop began with and the model this step is on.
    if ("provider" in state && config !== null) {
      if (decision === undefined && e.agentId !== undefined) {
        const id = e.agentId;
        let routed = await recall(r, $, id, ladder);
        if (
          routed === undefined &&
          attempt === undefined &&
          !known(r, id) &&
          r.handoffs.size > 0
        ) {
          const prompt =
            r.unclaimed.get(e.turnId) ?? (await firstPromptOf($, id));
          if (prompt !== undefined) {
            const got = claim(r, prompt, id, { model: e.model }, false);
            if (got !== PENDING) routed = got;
          }
        }
        if (routed === undefined && r.waiting.has(id)) {
          const text =
            r.unclaimed.get(e.turnId) ?? (await firstPromptOf($, id));
          routed = await routeWaiting(r, $, state.provider, id, text, config);
        }
        if (routed !== undefined) {
          // A step is no first turn to compare a spawn's prompt against;
          // the prompt goes, so that no later wake is taken for one.
          if (routed.prompt !== undefined) {
            routed = settled(routed);
            remember(r, id, routed);
          }
          bind(r, e.turnId, routed);
          decision = routed.decision;
          attempt = routed.attempt;
        }
        await flush(r, $);
      }
    }

    // A subagent nobody routed: a fork, a resume, one started before the
    // router loaded, or any while routing is off. It is recorded with the
    // model that ran it, or /jev would show one prompt and hide the
    // requests it caused.
    if (attempt === undefined && e.agentId !== undefined) {
      const agent = await agentTagOf($, e.agentId);
      attempt = {
        prompt: agent.label,
        ms: 0,
        skipped:
          "off" in state
            ? state.off
            : (r.unrouted.get(e.agentId) ?? NO_SPAWN_SEEN),
        kind: "agent",
        agent,
      };
      record(r, attempt);
      r.byTurn.set(e.turnId, attempt);
      trim(r.byTurn);
    }

    // Off is off: the request goes as the engine resolved it.
    let sent = e;
    if (config !== null) {
      // The settings may have changed since the decision was made: a Fable
      // pick made under "open" runs on Fable only while the setting still
      // lets it, and every decision runs inside the bands of this moment,
      // so a band narrowed mid-session reaches work decided before it. The
      // stored decision is left as it was: widening the band again gives
      // back the effort Jev asked for.
      if (decision !== undefined) {
        decision = fableGate(
          revivedDecision(decision, ladder) ?? decision,
          config.fable,
          config.fableConfidence,
          ladder,
        );
      }

      // The model the engine resolved the turn's first step to; a later
      // step on another is one it moved to a fallback, which keeps the
      // engine's model, under the Fable guard and the bands.
      if (!r.firstModels.has(e.turnId)) {
        r.firstModels.set(e.turnId, e.model);
        trim(r.firstModels);
      }
      const moved = r.firstModels.get(e.turnId) !== e.model;

      // The decision when there is one; otherwise the Fable setting, and
      // the bands: a step nobody decided keeps its model but not an effort
      // its family's band refuses.
      if (decision !== undefined && !moved) {
        sent = { ...e, model: decision.model, effort: decision.effort };
      } else if (isForbiddenModel(e.model, config.fable)) {
        const target = guardTargetOf(ladder);
        sent = { ...e, model: modelOf(target.tier), effort: target.effort };
        if (attempt !== undefined) attempt.blocked = e.model;
      } else {
        sent = banded(e, ladder);
      }
    }

    const step = next(sent);

    // Nothing is ever put into a subagent's reply: that is a tool result
    // its parent reads, and a route line in it would be read as the answer.
    const ours =
      attempt !== undefined && !isSubagent(attempt) && e.agentId === undefined;
    // Nor into a reply nothing draws: there the text is the program's result.
    const shown = ours && (await drawsReplies($));

    // The block the footer joins, so it lands at the end of the reply's text
    // rather than opening a block of its own.
    let lastTextIndex = 0;

    for await (const chunk of step) {
      if (chunk.kind === "text") {
        lastTextIndex = chunk.index;
        if (attempt && shown && r.pending.has(e.turnId)) {
          r.pending.delete(e.turnId);
          yield {
            ...chunk,
            text: `${liveLine(attempt)}${REPLY_SEPARATOR}${chunk.text}`,
          };
          continue;
        }
      }

      if (chunk.kind === "stop") {
        if (attempt && chunk.usage) addUsage(attempt, chunk.usage);

        // The index must be one past the last text block, and this is
        // load-bearing. A chunk yielded at an index the engine already
        // streamed is dropped on the floor, silently: probed live, a chunk
        // at `lastTextIndex` never reached the transcript, one at
        // `lastTextIndex + 1` did. It opens a block of its own, which is
        // what a footer wants anyway — the reply above it stays untouched.
        //
        // No `ref`, because the engine's handle belongs to a chunk the
        // engine streamed; one a hook built has none and is taken at its
        // word. It goes before the stop chunk, the last thing the engine
        // expects to see.
        if (
          attempt &&
          shown &&
          r.announce &&
          !MID_TURN.has(chunk.stopReason ?? "")
        ) {
          const footer = usageFooter(attempt);
          if (footer !== null) {
            yield {
              kind: "text" as const,
              index: lastTextIndex + 1,
              text: `${FOOTER_SEPARATOR}${footer}`,
            };
          }
        }
      }

      yield chunk;
    }
  });

  // A turn that ended steps no more, so what it was bound to goes: this is
  // how the lookups stay small, rather than by dropping their oldest
  // entries, which in a fan-out are turns still running. The row itself
  // stays in the history, usage and all. An agent's own routing stays too,
  // in `byAgent`: a message can wake its loop for another turn.
  on("turn.complete", async ($, e, next) => {
    try {
      return await next(e);
    } finally {
      forget(r, e.turnId);
    }
  });

  // The footer, where a surface draws one. The announcement above is what
  // carries on surfaces that draw no footer, which is most of them.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const label = labelOf(r.latest, r.enabled && r.keyed);
    const modes = withLabel(e.props.modes, label);
    return next({ ...e, props: { ...e.props, modes } });
  });
}
