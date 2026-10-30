# jev-router

Picks the model for each turn, and for every subagent, with
[Jev](https://docs.typesafe.ai), TypeSafe's decision model. Supports both
TypeSafe's direct API and the Vercel AI Gateway.

[MIT licensed](LICENSE).

It exists to save money. You type a prompt. Before the turn runs, Jev is asked
one question: which model, thinking how hard, should answer it. The options
are model·effort pairs (`haiku_medium`, `sonnet_high`, `opus_xhigh`), one
for each effort in each family's band, so a pairing the policy does not allow
(`haiku·max`, say) is never on offer. Jev is shown your request with the
last few messages before it and the files the agent has been working on, as
named fields, or your request alone if you set `context` to `request` (see
[What is sent to TypeSafe](#what-is-sent-to-typesafe)). Jev answers with probabilities; the decision is made in code,
family first: the families are ordered by what they can do, so the router
adds each family's pairs up and picks the cheapest family that at least half
of Jev's probability says is enough (that family or a cheaper one), then the
likeliest of that family's pairs; when that family holds less than half of
Jev's probability, its own pairs are a minority's ranking, and the effort is
the median effort of the whole answer instead, kept inside the family's
band. Every model request in that turn then goes
to the family and effort that came out, and a line above the reply says
which one. Opus at high effort is the default, Opus at max effort is the
ceiling, and Fable is off unless you turn it on. The default and every band
are settings (see [Settings](#settings)).

```
Context    you type a prompt
              ↓
turn.start    state: { request, recent_conversation, files_in_play, continuing }
              ask Jev  →  route: sonnet_high 0.05 · opus_high 0.22 · opus_max 0.71 · …
              families: haiku 0.00 · sonnet 0.06 · opus 0.94
              cheapest family with ≥ 50% on it or cheaper  →  opus (100%)
              likeliest opus pair  →  opus·max
              ↓
turn.step     next({ ...e, model: 'claude-opus-5-5', effort: 'max' })
              first text chunk ← '> ✳️ `opus·max` · 100% · 641ms\n\n---\n\n' + text
              ↓
/jev          the full history, with the reason for any fallback
```

Subagents go through the same ladder, asked once when they start:

```
Context      the Agent tool, or a Workflow script's agent(), starts a subagent
                ↓
agent.spawn  state: { brief, task, agent_type, from_workflow }
             ask Jev about its brief  →  families: haiku 0.02 · sonnet 0.81 · opus 0.17
             →  sonnet (83%), likeliest sonnet pair sonnet_high
             next({ ...e, model: 'claude-sonnet-5-5' })
                ↓
turn.step    next({ ...e, model: 'claude-sonnet-5-5', effort: 'high' })   at each of its steps
```

## The ladder

| Family | Model | Effort band | Used for |
| --- | --- | --- | --- |
| `haiku` | `claude-haiku-5-5` | `medium`–`high` | Trivial beyond doubt: no model could get it wrong. A yes or no from text already given, one named lookup, a single rename. |
| `sonnet` | `claude-sonnet-5-5` | `medium`–`max` | Simple implementation, from really simple to relatively simple, with nothing hard to decide. A small edit whose shape the request already spells out, a small function, a straightforward test. |
| `opus` | `claude-opus-5-5` | `medium`–`max` | **The default, at `high`.** Real complexity, several files, debugging, ordinary planning and research, code review, verifying work already done, an unfamiliar codebase, anything that does not clearly fit another family; and the exceptional hard cases, which its `max` effort is for. Under `open`, implementation of any size, hard implementation included (see [Settings](#settings)). |
| `fable` | `claude-fable-5-1` | `medium`–`max` | **Off by default.** Offered only when the `fable` setting allows it; what it is for depends on the mode (below). |

Each family offers Jev one option per effort in its band: ten pairs on the
default bands, `haiku_medium` to `opus_max`, and four more for Fable when
it is on. How a pair is picked from Jev's probabilities is
[The confidence floor](#the-confidence-floor), and what the options say and
why is [What Jev is asked](#what-jev-is-asked).

What Jev is told each family is for depends on the Fable mode, so the policy
is `criteriaOf(mode)` in `hooks/policy.ts`, the kind of work each family
takes; how hard each effort thinks is `THINKING` beside it, and each option
is the two composed (`pairCriteriaOf`). Those strings are what Jev reads, so
editing them is how you change the router's behaviour. The bar for leaving
the default rises the cheaper the family: Haiku is for work nothing could
get wrong, and "if there is any doubt at all, this is not Haiku". The pair
you make the default is the one Jev is told is the catch-all, once, on that
option alone: "anything that does not clearly fit another option belongs
here". With `defaultModel` set to `sonnet` that sentence moves to
`sonnet_high`, and Opus keeps its work but loses the claim, so unclear work
lands on Sonnet rather than on Opus. With a Haiku default, Haiku's "any
doubt" line goes too, since it cannot be both.

Model ids live in `MODEL_OF_FAMILY`, and the bands a new user gets in
`DEFAULT_BANDS`, in the same file; change a model there and every decision on
that family follows. Everyone who shares the mod can set their own bands and
default without touching code (see [Settings](#settings)).

### Fable is off by default

Under the default, `never`, Fable is not a family Jev is offered, not a
fallback, and not what runs when something asks for it: a session set to
Fable, an Agent call with `model: "fable"`, or a Workflow script that pins
forty agents to `claude-fable-5-1`. That last one is the bill this router
exists to stop.

It is enforced twice. Every decision the router makes has been through the
Fable gate (`fableGate` in `policy.ts`), so a routed request only lands on
Fable when the setting lets Jev's pick stand. And a request that arrives with
no decision is checked against the setting: when its model matches `/fable/i`
(`isForbiddenModel`, loose enough to catch dated ids and aliases) and the mode
refuses it, it is moved to the default, `claude-opus-5-5` at `high` unless
you set another default; a default below Opus is lifted to Opus, at the
default's effort, since a request for the strongest model by name says the
work is at least Opus work (`guardTargetOf`). That covers what the router
chose not to ask Jev about: a fork, a resumed subagent, an agent started
before the mod loaded, a teammate it never saw spawn, a step the engine moved
to a fallback model. A fork or an unrouted spawn asking for Fable is moved at
the spawn as well. A moved step shows under its row in `/jev`, when it has
one, as `blocked <model> → opus·high`.

The gate runs again at every step, against the setting as it is then: an
agent Jev put on Fable under `open` drops to `opus·max` at its next request
once the setting says `never`, rather than running on Fable until it ends.
The bands are re-applied at every step the same way, so narrowing Opus to
`high` mid-session brings an agent Jev put on `opus·max` down to `opus·high`
from its next request, and widening it again gives the `max` back.

Per mode:

- **`never`** refuses Fable everywhere, as above.
- **`hardest`** offers Fable to Jev, but a Fable pick only runs there when
  Jev put at least `fableConfidence` of its probability on Fable itself
  (P(fable), among the families offered; not the answer's `confidence`,
  which measures how peaked the answer is). A Fable pick under that bar runs
  on Opus at the top of its band instead (`opus·max` on the default bands, whatever effort Jev
  gave), marked `capped:fable`. An unrouted request that names Fable is
  still clamped, since a script asking for Fable by name is exactly what the setting
  is there to stop.
- **`open`** makes Fable an ordinary family, and the guard refuses nothing. A
  routed request still runs on whatever Jev picked, since Jev's pick overrides
  the caller's model; an unrouted one (a fork, a resume) runs on what it asked
  for, Fable included.

The guard is part of routing, and goes down with it. **Off means off**:
after `/jev off`, or with no Jev key set at all, the mod touches nothing.
No Jev call, no model or effort rewritten, no Fable clamp, on the main loop
and on every subagent: a session set to Fable runs on Fable, and a script
that pins its agents to Fable gets Fable. If you want the guard, keep routing
on and a key set.

## What Jev is asked

One request per turn and per subagent, one question in it, `route`: a
Choice among the pairs the ladder allows. The question says only what is
being chosen, "Which model, thinking how hard, should answer this request a
developer typed to a coding agent?" (or, for a subagent, "should carry out
this task, which a coding agent is handing to a subagent to do alone"). What
each option means is in its criterion, so the question does not repeat it.

**Each option reads as a situation.** An option is its family's line (the
kind of work) and its effort's line (how much thinking it takes), and the
effort lines differ by family. On a family whose work is simple, Haiku and
Sonnet, a higher effort is "simple work that is long or has many parts to
keep straight" (`xhigh`) or "simple work where a slip would be costly to
undo" (`max`), never "nothing hard to decide, but think as hard as
possible", which says two things at once and in the comparison pulled
ordinary work off Opus. Opus and Fable's efforts are about how hard the
problem is; "clearly exceptional" lives on `opus_max` alone.

**The effort lines are read against the band** (`thinkingOf`). Each
describes its level against its neighbours, which only holds while the
band offers them. A band of one level (`JEV_ROUTER_OPUS_EFFORT=max`) says
nothing of thinking: the family's line is the whole option, since all its
work runs there. The lowest pair of a band that starts above `medium`
(`xhigh-max`) drops "harder than ordinary" and adds that lighter work
belongs there too, so ordinary Opus work still has an Opus option rather
than drifting to Sonnet. And the default pair never says ordinary work is
not for it: `defaultEffort=max` puts the catch-all on `opus_max` without
"hard but ordinary work is not this" beside it. On the default bands every
line reads as written.

**The catch-all is said once**, on the configured default pair and nowhere
else: not in the question, not on the family line. Said on the option and
again in the instructions, as the comparison's version did, it was the same
pull twice.

**The decision is code** (`pairPickOf` in `policy.ts`, tested). The pair
probabilities are renormalised over the pairs offered and added up per
family; the family is the cheapest whose share, with every cheaper one's,
reaches `minConfidence` (0 takes the family with the most); the effort is
the likeliest pair within it, ties to the lower effort, when the family
holds at least half of the probability on its own, and otherwise the median
effort level across every offered pair, each weighed by its share, ties to
the lower effort (`spreadEffortOf`); and the effort is clamped into the
family's band. The second case is a bare "looks good, ship it", split haiku
.47, sonnet .20, opus .33: half is reached on Sonnet, and `sonnet_max`, at
.07, topped Sonnet's own pairs, so it ran Sonnet at max on 7% of Jev's
belief; across the whole answer the median effort is high, which is what it
runs at now. The half is the same majority as the default floor, not a
number fitted to that case: below it, a family's ranking of its own efforts
is a minority of the answer speaking for all of it.
Family first, because a cumulative rule run down the mixed list of pairs
fails both ways: `sonnet_medium .05, sonnet_high .39, sonnet_xhigh .13,
opus_high .37` reaches half on `sonnet_xhigh`, an effort Jev gave 13%, and
any split between `sonnet_max` and `opus_high` lands on Sonnet however
little is there, since every Sonnet pair sorts below every Opus pair. The
models are ordered by what they can do; efforts within a model are not
ordered that way, only by cost, so the ordered question is asked of the
models only. An answer with no readable probabilities falls back to its
`choice` when that is an offered pair, else to the default.

### What Jev is shown

Named fields, built by pure functions in `hooks/state.ts` from the
transcript and the directory the engine hands over. A field with nothing in
it is left out rather than sent empty, since an empty list is itself a
signal.

A main-loop turn:

| Field | What it is |
| --- | --- |
| `request` | What you typed. On a turn a finished background task woke, the notification's summary. |
| `recent_conversation` | The last few messages between you and the agent before it, oldest first, as `{ from: "developer" \| "agent", text }`. Tool calls and their results, the agent's narration between calls, slash commands and their output, a loaded skill's instructions, notifications and teammate, cross-session or channel messages (a bracketed label before the envelope included), reminders and the router's own route line and footer are left out. |
| `files_in_play` | The files the agent's Read, Edit, Write, MultiEdit and NotebookEdit calls (and a Glob or Grep scoped to a file) touched in the last 50 transcript rows, newest first, each once, relative to the session's directory. Failed calls do not count. |
| `continuing` | `true` when the request follows earlier turns of the session, even when none of them is shown (compacted away, or all tool calls). A slash command run before your first request is no earlier turn. |

A request typed to a coding agent is short and leans on what came before:
"do the same for the other two" fails the human test on its own, since
nobody can tell from it whether "the same" is a rename or a migration. The
last exchange says what it refers to, and the files say what it touches.

A subagent or workflow agent:

| Field | What it is |
| --- | --- |
| `brief` | The prompt its caller wrote. |
| `task` | The caller's short description. |
| `agent_type` | `general-purpose`, `Explore` and the like. |
| `from_workflow` | `true` when a Workflow script's `agent()` started it. |
| `parent_request` | What you last typed to the main loop, first 300 characters, only when the brief is under 400 characters. Kept as each typed turn starts (a notification or a teammate's message is not you typing); after a plugin reload it is read once from the transcript, by the first thin brief that needs it. |

A brief is written to be carried out alone and usually says all there is;
your request would be a second account of the same work, written before the
agent split it up. It earns its place beside a brief too thin to judge ("Review
the diff.").

**The budget, and why.** Each field has its own cap: a message's first 400
characters, at most 4 messages and 1600 characters of conversation, at most
10 files. The whole serialized state has one more, 4000 characters
(`STATE_BUDGET`), and when it runs over, what goes first is what matters
least: the oldest conversation, then the oldest files, and only then the
middle of the request or brief, whose head (what to do) and tail (what to
hand back) are kept with a marker saying how much went. Context costs twice:
it is paid for and waited on before the turn starts, and history that is
mostly about something else dilutes the one thing being judged (context rot).
TypeSafe's own guidance is that every field in the state should be relevant;
these are the ones a person deciding "which model, how hard" would look at.

Reading costs one `$.session.messages()` and one `$.session.cwd()` per
main-loop turn, side by side, each given 250ms at most. A read that fails or
does not answer leaves its fields out, and Jev is asked about the request
alone; it never holds up or blocks a turn. Under `context: request`
neither is read. A spawn reads nothing: the
developer's latest request is the router's own copy, kept at the main loop's
`turn.start`, so a workflow fanning out to forty agents costs no read at
all. Rows in `/jev` keep showing the text you typed, never the JSON.

### What is sent to TypeSafe

Each question goes to TypeSafe (directly, or through the Vercel AI Gateway)
with the fixed question and the option descriptions, which are built from
your settings (the bands, the default, the Fable mode) and say nothing about
your session, and with the state, which does. What the state holds is the
`context` setting's:

| | `full` (the default) | `request` |
| --- | --- | --- |
| A main-loop turn | `request`, `recent_conversation`, `files_in_play`, `continuing` | `request` only |
| A subagent or workflow agent | `brief`, `task`, `agent_type`, `from_workflow`, and `parent_request` beside a brief under 400 characters | `brief`, `task`, `agent_type`, `from_workflow` |

Under `request` the router never reads the main loop's transcript or the
session's directory for a question at all. A subagent's brief is still sent,
since the brief is the task being routed.

`recent_conversation` includes the agent's replies, and a reply can quote
tool output: a file's contents, a command's result, a secret it printed. So
`request` is the privacy-conservative choice. What it costs is the context
a short request leans on: "do the same for the other one" is judged on those
words alone, and lands where an unclear request lands.

### Why one question over pairs

The two-question design it replaced (a Choice over families plus a Score
over five effort levels, about the bare request) was compared against one
Choice over the ten pairs, on 32 cases labeled independently of either
design (`scripts/eval/cases.json`, recorded in
`scripts/eval/ab-results.json`, jev-1.14.0, 2026-10-30):

| Design | In the acceptable set |
| --- | --- |
| Family Choice + effort Score, as shipped then | 23/32 (72%) |
| Pair Choice, Jev's top pair | 28/32 (88%) |
| Pair Choice, cumulative down the mixed list | 26/32 (81%) |

The pair Choice's top pair was right on 6 cases the two questions got wrong,
and wrong on 1 they got right. That is **not significant**: an exact
McNemar test on 7 discordant cases gives p ≈ 0.13. What it did show, case
by case, is better Haiku handling (on the eight trivial cases the family
question put most of its probability on Sonnet five times and routed 3 of 8
right, the pair Choice 6 of 8), the effort Score lifting two ordinary
subagent briefs to `opus·xhigh`, and three weaknesses of the pair Choice, each fixed above in the wording or the rule rather than by
tuning to the cases: the cumulative rule over the mixed list, the
self-contradictory higher efforts on Sonnet, and the doubled pull to the
default. The pair request also ran about 21% more input tokens, and the
shipped one, with every family's line on each of its efforts, is longer
again. The shipped wording, the family-first rule and the new state fields
have **not** been run against the cases yet;
`node scripts/eval/compare.mjs` does that (see
[Checking and tuning](#checking-and-tuning)).

## Setup

### Provider: TypeSafe direct or Vercel AI Gateway

Get either a TypeSafe API key or an AI Gateway key and put it in the `env` block
of `~/.claude/settings.json`. The router prefers TypeSafe direct when both keys
are set:

```json
{
  "env": {
    "TYPESAFE_API_KEY": "...",
    "AI_GATEWAY_API_KEY": "...",
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

**For TypeSafe direct:** Get a key from your [TypeSafe account](https://console.typesafe.ai/keys).

**For the Vercel AI Gateway:** Get a key from your [Vercel dashboard](https://vercel.com/dashboard) and note
that the gateway **needs a card on the account**, not just a key. A valid key
on an account with no payment method gets:

```
HTTP 403  customer_verification_required
"AI Gateway requires a valid credit card on file to service requests."
```

A personal-scope gateway key needs a card before it serves anything, even on free
credits. A team-scope key reportedly does not.

**Forcing a provider:** If both keys are set and you want to use the gateway,
set `JEV_ROUTER_PROVIDER=gateway`. Similarly, `JEV_ROUTER_PROVIDER=typesafe`
forces TypeSafe direct.

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not optional. Without it the mod loads
and silently does nothing, with no warning.

With no key at all the mod is off, exactly as after `/jev off`: replies carry
no route line, and every turn and subagent runs on what it was given, as it
would without the mod, Fable included. `/jev` says so on its first lines
(`routing   off — no Jev key is set, so nothing is routed`) and says how to
set one. A key the provider refuses, or a card it wants, is different: the
mod is on and asking, so it shows up as `⚠️ opus·high · fallback — <reason>`
on every reply. Run `npm run check-jev` to see which provider is configured
and whether it's serving.

Then run Claude Code with the mod:

```
claude --plugin-dir ~/Desktop/jev-router
```

To keep it on permanently, move the folder to `~/.claude/skills/jev-router/`,
where it loads on its own next session.

## Settings

The mod is shared, so the money-saving policy is the default and the things
people disagree about are settings: how willing they are to pay for Fable,
which model is the default, how hard each model may think, and how much of
the session each question carries. There are eleven:

| Setting | Option key | Env var | Default |
| --- | --- | --- | --- |
| How far up Fable is allowed | `fable` | `JEV_ROUTER_FABLE` | `never` |
| The share of Jev's probability on Fable a Fable pick needs under `hardest` | `fableConfidence` | `JEV_ROUTER_FABLE_CONFIDENCE` | `0.75` |
| The share of Jev's probability that must say a family (or a cheaper one) is enough | `minConfidence` | `JEV_ROUTER_MIN_CONFIDENCE` | `0.5` |
| Route subagents and workflow agents | `routeSubagents` | `JEV_ROUTER_SUBAGENTS` | `true` |
| The default model | `defaultModel` | `JEV_ROUTER_DEFAULT_MODEL` | `opus` |
| The default effort | `defaultEffort` | `JEV_ROUTER_DEFAULT_EFFORT` | `high` |
| Haiku's effort band | `haikuEffort` | `JEV_ROUTER_HAIKU_EFFORT` | `medium-high` |
| Sonnet's effort band | `sonnetEffort` | `JEV_ROUTER_SONNET_EFFORT` | `medium-max` |
| Opus's effort band | `opusEffort` | `JEV_ROUTER_OPUS_EFFORT` | `medium-max` |
| Fable's effort band | `fableEffort` | `JEV_ROUTER_FABLE_EFFORT` | `medium-max` |
| What each question carries | `context` | `JEV_ROUTER_CONTEXT` | `full` |

- **`fable`** is `never`, `hardest` or `open`. In `JEV_ROUTER_FABLE` any
  case will do (`Hardest`, `OPEN`). The option must be spelled exactly, in
  lower case: the engine treats a stored value outside the picker's
  `options` as unset and fills in the default, so a hand-written
  `"fable": "Hardest"` in settings.json quietly means `never`, and `/jev`
  shows `fable never (default)`. The same holds for every picker below.

  | Mode | Fable offered to Jev | What `opus` at max and `fable` mean | A request for Fable with no decision |
  | --- | --- | --- | --- |
  | `never` | no | `opus·max` is the ceiling, for the clearly exceptional | moved to the default lifted to Opus, `opus·high` |
  | `hardest` | yes | `fable` only for the exceptional few where even Opus at max would likely fall short; a pick with less than `fableConfidence` of Jev's probability on Fable runs on Opus at the top of its band, marked `capped:fable` | moved to the default lifted to Opus, `opus·high` |
  | `open` | yes | `fable` for planning, brainstorming, architecture, systematic debugging, trade-offs and research; `opus` for implementation of any size, hard implementation included | runs as asked |

- **`fableConfidence`** is in (0, 1], a share of Jev's probability on
  Fable. A value above 1 reads as a percentage, so `80` is 0.8. 0 is not a
  bar, and is skipped.
- **`minConfidence`** is in [0, 1], also read as a percentage above 1. The
  pick is the cheapest family where Jev's probability on it and every
  cheaper family, each family's pairs added up, comes to at least this; at
  the default, 0.5, that is the median of Jev's answer. The effort is then
  the likeliest of that family's pairs, or the median effort of the whole
  answer when the family holds less than half of it. Higher leans toward stronger models,
  lower toward cheaper ones. `0` turns the floor off and takes the family
  with the most of Jev's probability. It reads
  Jev's distribution, not the default model, so it picks the same family
  whatever `defaultModel` is. The name is the one it had when it was a bar on
  the answer's `confidence`, kept so a value already set still means "how
  sure before going cheap". See
  [The confidence floor](#the-confidence-floor).
- **`routeSubagents`** takes `true`/`false`, or in the env var `1`, `true`,
  `yes`, `on` and `0`, `false`, `no`, `off`. Off, subagents and workflow
  agents are not asked about and run on what they were given, under the Fable
  guard all the same; the main loop is still routed.
- **`defaultModel`** is `haiku`, `sonnet`, `opus` or `fable` (any case in the
  env var). It is where a turn runs when Jev cannot be asked or does not
  answer usably, the family Jev is told is the default for anything
  unclear, and what `/jev` calls the
  default. A refused Fable request with no decision goes to it too, lifted to
  Opus when it sits below. `fable` only counts under the `open` Fable setting: under `never`
  Fable is above the ceiling, and under `hardest` only a pick of Jev's with
  enough of its probability on Fable may run on it, which a fallback is not. Refused, Opus stands in and
  `/jev` says so.
- **`defaultEffort`** is `low`, `medium`, `high`, `xhigh` or `max` (any case
  in the env var). It is the effort the default model runs at, which makes
  that pair the one Jev is told unclear work belongs to, and the one a
  fallback runs on. It is clamped into the default model's band: a default of `haiku` at `max` runs at `haiku·high`, and `/jev`
  says the effort was clamped.
- **`haikuEffort`, `sonnetEffort`, `opusEffort`, `fableEffort`** are effort
  bands: one level (`high`, meaning `high` to `high`) or `lowest-highest`
  (`medium-xhigh`). Every effort on that family is clamped into its band,
  Jev's answer, the default and a held turn's alike, and so is a step nobody
  decided (a fork, a resume, a teammate whose spawn was not seen, a step the
  engine moved to another model): it keeps its model, but not an effort the
  band refuses. Narrow Opus to `high` and nothing runs on Opus at more than
  `high`, the Fable cap under `hardest` included; a session on Haiku at
  `/effort low` runs its unrouted steps at `medium`. Only an effort given as
  a number, none at all, or a model the ladder does not know goes as it came.
  With routing off nothing is clamped. A band is also which pairs Jev is
  offered: widen Haiku to `low-high` and `haiku_low` becomes an option, and
  a Haiku pick at it runs at `low`. In the option the band is a picker over all fifteen valid
  bands, since the engine treats anything outside a picker's `options` as
  unset and the list leaves nothing out; in the env var any case will do, and
  the separator may be `-`, `–` or `..` (`LOW..High`). A band whose minimum is
  above its maximum (`max-medium`) is refused rather than turned round, and
  falls through to the next source.
- **`context`** is `full` or `request` (any case in the env var), and says
  what each question carries to TypeSafe: under `full` the conversation and
  files around a request, under `request` the request (or a subagent's
  brief) alone, with no read of the transcript. The fields of each are in
  [What is sent to TypeSafe](#what-is-sent-to-typesafe). Anything else
  falls through to the next source.

How the ladder settings bear on one another (a default the Fable setting
forbids, a default effort outside its band) is decided in one place,
`ladderOf` in `hooks/policy.ts`, which builds the `Ladder` every decision is
made on. A setting it could not take as asked is never an error: it runs the
nearest thing it can, and `/jev` shows both what was asked and what runs.

Each field is read from the env var first, then the plugin option, then the
default (`configOf` in `hooks/config.ts`). A value that cannot be read is
skipped for the next source rather than refused: a typo costs you the
override, not the router. `/jev` prints each setting with where it came from,
`(env)`, `(option)` or `(default)`. The engine fills an unset option with its
manifest default, so an option set to the default reads `(default)`.

There are three ways to set them:

- **The config menu.** Each setting is a row in `/config`, declared by the
  `userConfig` block in `.claude-plugin/plugin.json`; `fable`, the default
  model, the default effort, the four bands and `context` are pickers. A change there
  reloads the module with the new options.
  What `/jev` set (`off`, `quiet`, `sticky`), what the main loop last
  ran on, and each agent's routing are kept in the host's `$.state`, so the
  reload loses none of them: a teammate routed to Opus before it is not asked
  about again on the message that wakes it after, and the turn after it
  still has a model to hold to and a continuation one to carry on with. Each
  is kept as decided and clamped at its step, so narrowing a band and
  widening it again gives back the effort Jev picked. An install from a marketplace shows a screen for them too.
- **`pluginConfigs` in `~/.claude/settings.json`**, which is where the menu
  stores them, keyed by the plugin. For a `--plugin-dir` plugin the key is its
  name, `jev-router` (or `jev-router@inline`):

  ```json
  {
    "pluginConfigs": {
      "jev-router": {
        "options": {
          "fable": "hardest",
          "fableConfidence": 0.8,
          "defaultModel": "opus",
          "opusEffort": "medium-xhigh"
        }
      }
    }
  }
  ```

- **The env vars**, in the `env` block of settings.json or the shell. These
  win over the options, which makes them the way for a project or a shell to
  override what the menu says. The router reads them at every turn, spawn
  and step, not once at startup.

## Knowing whether it is working

Four signals, in order of how much you can trust them.

**`/jev`** prints the full state. A command's output row draws on every
surface, so this always works:

```
jev-router
  routing   on
  surface   desktop
  provider  typesafe · TYPESAFE_API_KEY is set
  budget    1500ms
  sticky    on, switch needs 75%
  fable     never (default) — opus·max is the ceiling
  default   opus·high — model (default), effort (default), for fallbacks and anything unclear
  ladder    haiku   claude-haiku-5-5   medium–high
            sonnet  claude-sonnet-5-5  medium–max
            opus    claude-opus-5-5    medium–max  (default: high)
  floor     a pick needs 50% (default) of Jev's probability on it or cheaper
  blocked   fable, whatever asks for it
  agents    each new subagent and workflow agent asks Jev (default)
  context   full (default) — sends the request, recent chat (may quote tool output), files
  announce  on, a line per turn

  Recent turns, newest first:
   653ms  opus·high 1.00  [notify] Agent "Review library-sync cluster" complet…
          answered claude-opus-5-5 ✓  cache 96%  45k in  1k out
   588ms  opus·xhigh 1.00  [workflow:general-purpose] Verify race fix
          asked claude-fable-5-1 → opus·xhigh
          answered claude-opus-5-5 ✓  cache 0%  18k in  3k out
   433ms  sonnet·medium 0.83  [agent:Explore] Find config loader
          answered claude-sonnet-5-5 ✓  cache 0%  22k in  1k out
     0ms  unrouted — [agent:fork] Review library-sync cluster
          blocked claude-fable-5-1 → opus·high
          answered claude-opus-5-5  cache 86%  22k in  1k out
  1503ms  opus·high fallback — timed out after 1500ms  what does this function return
          answered claude-opus-5-5 ✓  cache 97%  128k in  0k out
```

With no key set, the top of the report says routing is off and why, and how
to fix it; everything below runs as if the mod were not loaded, so `blocked`
reads `nothing, routing is off`:

```
jev-router
  routing   off — no Jev key is set, so nothing is routed
  surface   desktop
  provider  NO KEY — no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY
            set TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY) in the shell
            that starts Claude Code, or under "env" in settings.json,
            then run /jev again
```

The ladder lists only the families Jev is offered, each with its model and
the effort band its picks are clamped into: Fable appears on it only under
`hardest` or `open`, and `JEV_ROUTER_EXCLUDE` takes families off it. Under
`hardest`, with the mode set in the shell, the settings lines and a capped pick
read:

```
  fable     hardest (env) — a pick needs 75% (default), else opus·max
  ...
            opus    claude-opus-5-5    medium–max  (default: high)
            fable   claude-fable-5-1   medium–max
  ...
  blocked   fable, unless Jev itself picks it

  Recent turns, newest first:
   655ms  fable·high 1.00  prove the scheduler can never starve a tena…
   702ms  opus·max 0.38 capped:fable  design a lock-free queue that survives powe…
```

The `default` line and the bands are the ones in force, your settings
included, each with where it came from. A band nobody set prints no source,
since four `(default)`s beside `(default: high)` read as noise. With a
default of Sonnet set in the shell, a default effort of `max` and a wider
Haiku band set in the config menu, and Opus narrowed in the shell:

```
  fable     never (default) — opus·high is the ceiling
  default   sonnet·max — model (env), effort (option), for fallbacks and anything unclear
  ladder    haiku   claude-haiku-5-5   low–high (option)
            sonnet  claude-sonnet-5-5  medium–max  (default: max)
            opus    claude-opus-5-5    medium–high (env)
  floor     a pick needs 50% (default) of Jev's probability on it or cheaper
```

The ceiling follows the Opus band: narrowed to `medium-high`, a refused Fable
pick is capped to `opus·high`. A setting the ladder could not take as asked
gets a line saying what runs instead:

```
  default   opus·medium — model (env), effort (env), for fallbacks and anything unclear
            fable can't be the default under never, so opus
            low is outside opus's band (medium–max), so medium
```

Not every turn is you typing, and the history says which are not. A prompt
that spawns background agents produces more turns than replies: each agent
that finishes wakes the main loop with a `<task-notification>`, and the engine
starts a fresh turn with that XML as its text. Those are tagged `[notify]`,
with the notification's summary in place of the envelope, and the same tag
rides in the route line and footer of the reply they produce (`· notify ·`).
Without it, one prompt that dispatched three reviewers reads as one reply that
changed model three times.

The agents themselves are the `[agent:type]` rows, and `[workflow:type]` for
an agent a Workflow script's `agent()` started. Each is routed on its own (see
[Subagents and workflows](#subagents-and-workflows)), named by the short
description its caller gave. When the caller asked for a model, the row says
what it asked for and where it went instead: `asked claude-fable-5-1 →
opus·high`. A subagent the router chose not to ask about, a fork or a resume, is
listed as unrouted with the model that answered it, so the requests one prompt
really caused are all on the screen. Nothing is written into a subagent's
reply: that text is a tool result its parent reads.

The same `answered` information is under each reply as it happens, in the
footer below; `/jev` is where you go to see it across turns.

A fallback says why. It trades the confidence for the reason, because a dead
provider and a slow one cost the same Opus turn and only the reason tells them
apart.

The `answered` line under each turn is the API's own report, taken from the
`usage` on each step's `stop` chunk: which model actually answered, and what
the turn's requests carried. The route line above it is what the mod asked
for; this is what it got. `✓` means they agree (a dated id such as
`claude-opus-5-5-20261001` still counts); `≠ claude-opus-5-5` means something
else answered, which is the one case worth looking into. There is no need to
proxy traffic or force a bogus model id to check the rewrite lands.

`cache` is the share of the turn's input read from the prompt cache. The
cache is per model, so the turn after a switch runs cold, and a subagent's
first request always does. Cache reads bill at a tenth of uncached input, so a
switch on a large context costs roughly ten times what staying would have,
once. Watch this number to see whether Jev's switching is eating what the
cheaper families save.

**The first line of every reply.** The route is written into the reply's
own text, as the first text chunk streams through `turn.step`:

```markdown
> ✳️ `opus·high` · 98% · 555ms

---

Here is the implementation...
```

Markdown, because the line rides in the reply's text and that is what the
transcript renders, so it is the only styling available. The blockquote sets
it off from prose with a rail and dimmer text; the family and effort are
inline code, which the theme colours. The blank line before `---` is
load-bearing: a rule on the line directly after text is a setext heading
underline, and the route would render as a heading.

It reads family·effort, the effort as it runs, already clamped into the
family's band: `fable·high`, `opus·max`, `opus·high`, `sonnet·xhigh`,
`sonnet·medium`, `haiku·medium`. The percentage is the share of Jev's
probability that says the family it runs on, or a cheaper one, is enough:
P(family ≤ this one), the number the floor reads. It is not the answer's own
`confidence`, which TypeSafe defines as how concentrated the answer is. An
Opus turn with nothing offered above Opus is always 100%, and a held turn is
read the same way, for the model it was held on. Marks follow when
the turn did not simply go to Jev's top choice:

```
> ✳️ `sonnet·high` · 75% · floored:haiku · 455ms
> ✳️ `opus·medium` · 100% · held:sonnet · 512ms
> ✳️ `opus·max` · 38% · capped:fable · 700ms
> ⚠️ `opus·high` · fallback — gateway said HTTP 403 (customer_verification_required)
> ✳️ `sonnet·high` · 90% · continue · 0ms
> ⚠️ `unrouted` · empty prompt
```

`floored:<family>` names the family of Jev's top pair when the floor moved
the turn above it: too little of Jev's probability said that family or a cheaper one
was enough (see [The confidence floor](#the-confidence-floor)); `held:<family>`
is a switch stickiness kept on the model already loaded, at the effort Jev
asked for clamped into that model's band (see [Holding a shaky
switch](#holding-a-shaky-switch)); `capped:fable` is a Fable pick the setting
would not take (too little of Jev's probability on Fable under `hardest`), run on Opus at the top of its band instead; `fallback` is a
turn Jev could not route, run on the default, with the reason. A turn the
engine starts with no text at all (a continuation) has nothing to ask Jev
about: it carries on, on the family and effort the last turn ran on, tagged
`continue`, and with no last turn it is
`unrouted · empty prompt`, run on the session's model under the Fable guard.
With routing off, by `/jev off` or for want of a key, there is no line at
all. A `?` after the
percentage, as in `haiku·medium · 42%?`, means less than half of Jev's
probability says that family or a cheaper one is enough, and no mark explains
it. It is not a measure of how sure Jev was. At the default floor of 0.5 a
fresh pick never shows it; it appears with a floor set below 0.5 (a Haiku pick
at a floor of 0.4 can read 42%), on a choice-only answer whose probabilities
could not be read (the number is then the answer's own concentration), or on a
decision kept from before this rule.

**The footer under every finished reply**, which is the same information
settled. The top line is what the router asked for, before the reply exists;
the footer is what the API says it got, and it can only be written once the
response is whole:

```
─────────────────────────────────────────────────────
jev  opus·max · 97% · 641ms
api  claude-opus-5-5 ✓ · cache 91% · 130k in · 2k out
```

`api` is read off the `usage` on the step's stop chunk, so `✓` is the API's
own confirmation that the model rewrite landed — no proxy, no bogus model id.
A dated id such as `claude-opus-5-5-20261001` still counts as a match; a real
mismatch reads `claude-sonnet-5-5 ≠ claude-opus-5-5`.

`cache` is the share of the turn's input read from the prompt cache. The cache
is per model, so the turn after a switch runs cold:

```
─────────────────────────────────────────────────────
jev  haiku·medium · 75% · 402ms
api  claude-haiku-5-5 ✓ · cache 4% · 128k in · 0k out
```

That `4%` is the price of leaving Opus. Cache reads bill at a tenth of
uncached input, so a switch on a large context costs roughly ten times what
staying would have, once. Watch it to see whether the switching is eating what
the cheaper families save.

The footer is fenced because markdown collapses leading whitespace and joins
consecutive lines: unfenced, the rule and the two rows render as one run-on
paragraph. `<details>` was tried first, for a fold; the desktop app renders it
as raw tags.

It is emitted as a chunk the hook built rather than one the engine streamed,
at **one past the last text block's index**, and only on a step whose stop
reason ends the turn — a `tool_use` step is mid-reply. The index is
load-bearing: a chunk yielded at an index the engine has already streamed is
dropped silently. Probed live, a chunk at `lastTextIndex` never reached the
transcript and one at `lastTextIndex + 1` did, so the footer opens a block of
its own and the reply above it is untouched.

Note that `claude -p` shows only the *last* text block in its `result`, so the
reply looks like it vanished when the footer lands. It has not:
`--output-format stream-json --verbose` shows both blocks whole.

`/jev quiet` drops both the line and the footer without turning routing off;
`/jev loud` brings them back. Both ride in the reply's recorded text, so the
model sees them on its own past replies; that is the standing cost of a marker
on a surface that draws neither render sites nor `ui.log`.

The line is part of the recorded message, so the model sees its own past
replies open with it. That is the cost of a marker that reaches the desktop
app: two cleaner mechanisms were tried first and neither drew there. An
`AssistantMessage` render rewrite was correct against the generated types
and drew nothing; `$.ui.log`, documented as a dim transcript row, also drew
nothing. That tab reports `$.session.surface()` as `unknown` and appears to
be an SDK host that drops both. Reply text and command output are the two
channels that reach it.

**The footer**, via `SessionMode`: `jev → opus·high`, `jev → opus·high?`,
`jev → opus·max · capped:fable`, `jev → opus·high · fallback`, or `jev off`,
which it also says when no key is set. Terminal only in practice, so treat
its absence as meaning nothing.

The app's own model indicator will never change. It shows the *session*
model, which this mod does not touch — the rewrite happens per request, in
`turn.step`. A session set to Fable still says Fable there; under `never`,
and under `hardest` unless Jev picked Fable, the API's `answered` line is what
says it never ran.

## Commands and switches

- `/jev` prints the status above. `/jev on` and `/jev off` set routing
  explicitly rather than toggling blind. Off is the mod fully off: no Jev
  call, no model or effort rewritten and no Fable clamp, for the main loop
  and for every subagent; everything runs exactly as it came. No key set is
  the same off, and `/jev on` says so until one is. The switch survives a
  reload, a change in the config menu included.
- `/jev quiet` and `/jev loud` control the line at the top of each reply.
  Quiet still routes and still records, so `/jev` shows what you missed.
- The eleven settings, `JEV_ROUTER_FABLE`, `JEV_ROUTER_FABLE_CONFIDENCE`,
  `JEV_ROUTER_MIN_CONFIDENCE`, `JEV_ROUTER_SUBAGENTS`,
  `JEV_ROUTER_DEFAULT_MODEL`, `JEV_ROUTER_DEFAULT_EFFORT`, the four
  bands (`JEV_ROUTER_HAIKU_EFFORT`, `JEV_ROUTER_SONNET_EFFORT`,
  `JEV_ROUTER_OPUS_EFFORT`, `JEV_ROUTER_FABLE_EFFORT`) and
  `JEV_ROUTER_CONTEXT`, are in
  [Settings](#settings), along with the plugin options they override.
- `JEV_ROUTER_PROVIDER=typesafe|gateway` forces a specific provider. If both
  keys are set, the default is TypeSafe direct; use this to force the gateway.
- `TYPESAFE_BASE_URL=https://api.example.com` overrides the TypeSafe endpoint
  base (defaults to `https://api.typesafe.ai`). Useful for custom deployments.
- `JEV_ROUTER_EXCLUDE=haiku,sonnet` drops those families from the question
  entirely, so Jev is never offered them. Names are the families above,
  `fable` included, which is one way to keep Fable off the ladder under `open`
  while still letting unrouted requests run on it. Two families are never
  excluded: `opus`, where a refused Fable pick is capped to and whose
  criteria cover anything that fits nowhere else, and whichever family is the
  default model, since every fallback lands there and a
  default Jev may not pick is one the router reaches only by failing. Unknown
  names are ignored, the rung names of 0.2 (`sonnet-medium`, `sonnet-high`,
  `opus-high`, `opus-max`) among them: dropping all of Sonnet because one of
  its old rungs was named would take away more than was asked. To keep Sonnet
  from thinking at `max`, narrow its band instead (`JEV_ROUTER_SONNET_EFFORT`).
- `JEV_ROUTER_TIMEOUT_MS=2500` changes how long a turn, or a subagent's
  start, waits for Jev before giving up and running on the default. The
  default is 1500ms. Ten live calls on 2026-09-20 ran 402ms to 839ms, so an
  earlier 800ms default was giving up on the slowest of them.
- `/jev sticky` makes a switch down clear a bar before the model moves (a
  share of Jev's probability that says the cheaper model is enough), `/jev sticky 0.6` sets that bar, `/jev sticky off` stops. `--sticky`
  works too. See below.
- `JEV_ROUTER_STICKY=1` and `JEV_ROUTER_STICKY_CONFIDENCE=0.6` set the same
  thing for a session before it starts, for a project that always wants it.
  The command overrides them from then on.

## The confidence floor

Jev answers with a probability for each pair offered, and the router adds
each family's pairs up. The families are ordered by what they can do, Haiku below Sonnet below Opus
below Fable (Fable only when it is offered), so the probabilities say more
than which family comes top: added up from the cheapest, they say how likely
it is that a family or something cheaper is enough. The router picks the
cheapest family where that reaches the floor, `minConfidence`. At the
default, 0.5, that is the median of Jev's answer: the family at least half of
Jev's belief says will do, with the rest saying nothing cheaper would.

Why not Jev's top choice and its `confidence`, which is what an earlier cut
gated on: TypeSafe's [confidence](https://docs.typesafe.ai/confidence.md)
is a statistic of the distribution's shape, how concentrated the answer is,
not how likely it is to be right, and TypeSafe's integration guidance is
that it is rarely the right gate. On an ordered
ladder it gates the wrong thing. Four answers measured live on Jev 1.14, to
the family question that came before the pairs (a pair answer added up per
family is read exactly the same way):

| Request | haiku | sonnet | opus | confidence | At 0.5 | At 0.6 | Old floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bump a timeout constant | 0.59 | 0.41 | 0.00 | 0.38 | haiku | sonnet | opus·high |
| Find the config loader | 0.00 | 0.48 | 0.52 | 0.28 | opus | opus | opus |
| What does this function return | 0.29 | 0.48 | 0.23 | 0.22 | sonnet | sonnet | opus·high |
| Add a `--verbose` flag | 0.01 | 0.91 | 0.08 | 0.86 | sonnet | sonnet | sonnet |

The one-constant edit put no probability on Opus at all, and the old floor
(its 0.38 confidence under 0.5) sent it to Opus at high. Read as a
cumulative share, every last bit of Jev's probability says Sonnet or cheaper
is enough, and 59% says Haiku is.

When the floor moves the turn above Jev's top choice, the line says what the
top choice was:

```
> ✳️ `sonnet·high` · 75% · floored:haiku · 455ms
```

The percentage on every route line is that share, P(family ≤ the one that
runs). A moved pick runs at the likeliest of its new family's own pairs, so
work Jev split between `haiku_high` and `opus_max` runs at `opus·max` when
it lands on Opus, not at Haiku's effort. The
floor can also land below the top pair's family when Jev splits between
the two ends (45% Haiku, 47% Opus: the median is Sonnet), which is the cumulative
rule doing what it says, and carries no mark. Sonnet then holds a few
percent of the answer, too little for its own pairs to say how hard, so it
runs at the median effort of the whole answer, kept inside Sonnet's band.

`0` turns the floor off and takes the family with the most of Jev's
probability (ties to the family of the pair Jev named), rather than the
cheapest family with any probability, which is what a bar of 0 would
literally mean. The floor does not depend on `defaultModel`: the default is
where a failed call runs and where Jev is told unclear work belongs, and the
same answer picks the same family whatever it is. An answer that comes back
without probabilities (not something Jev sends) falls back to its `choice`,
taken as it stands. The floor applies to every pick, main loop and subagents
alike, before the Fable gate (so a pick it moves up onto Fable is still held
to the Fable bar) and before stickiness has its say. The effort is read the
same way on every pick: the likeliest pair within the family when it holds
at least half of Jev's probability, the whole answer's median effort when it
holds less, with no gate on how sure Jev was of either.

## Holding a shaky switch

The prompt cache is per model. A session cached under Opus is cold for
Sonnet, so the turn that switches pays full input tokens and a slower first
token. A router that flips model whenever half of Jev's belief says the
cheaper model will do can pick the cheaper model every time and still cost
more than staying put.

Run `/jev sticky` and a turn that would move to a cheaper model than the last
one has to clear the bar to move: at least that share of Jev's probability
has to say the cheaper model, or something cheaper still, is enough. That is
the same cumulative share the floor reads, held to a higher bar. Below it, the turn runs on the model already
loaded, and says so:

```
> ✳️ `opus·medium` · 100% · held:sonnet · 512ms
```

Jev's answer came to `sonnet` at `medium`, with 61% of its probability on
Sonnet or cheaper, and the bar is 75%, so the turn stayed on Opus. The
percentage is about the model that ran, as on every other turn: all of Jev's
probability says Opus or cheaper is enough, so 100%. `held:sonnet` is the
cheaper pick that was refused. The same `held:sonnet` appears in the footer and in
`/jev`, because a hold nobody can see is indistinguishable from a router that
is not running.

Only moves down are held. A move up goes through at any confidence, because
staying on a weaker model to save a cold cache is the one hold that can cost
correctness. A move that keeps the model (`sonnet·high` to `sonnet·medium`,
`opus·max` to `opus·high`) is never a switch at all, since effort costs no
cache.

A turn is never held on Fable, in any mode. Holding there would run a turn on
the dearest model when Jev did not pick it, past the Fable gate. Nor is a
fallback held: it is no pick at all, and held it would run on the last
turn's model with its `fallback` mark gone, so a failing provider would read
as an ordinary hold. It runs on the default and says why.

Only the model is held. The effort Jev asked for is applied either way,
clamped into the held model's band, which is why the held turn above reads
`opus·medium`: Opus, thinking as hard as Jev asked Sonnet to.

What the next turn holds to is the model actually running, not the one Jev
named. Three shaky `haiku` calls in a row will not creep the session onto
Haiku one turn at a time. A fallback turn counts like any other: it really ran
on the default, `opus·high`, so that is what the next turn holds to. An unrouted turn
leaves nothing to hold to.

Stickiness is the main loop's alone. A subagent starts with a fresh context,
so there is no cache for a hold to protect.

The bar starts at 0.75, which is a starting point rather than a measured
optimum. Retune it in place with `/jev sticky 0.6` and watch the next few
turns; `npm run try-prompts` prints Jev's probabilities and the cumulative
share behind each pick across a set of prompts, which is the other input to
picking a number. `/jev sticky` on its own keeps
a bar you have already set, so turning it off and on again does not lose it.

A session that should always be sticky can say so before it starts, with
`JEV_ROUTER_STICKY=1` in the `env` block of settings.json. The command wins
after that.

## Subagents and workflows

Every agent the session starts goes through Jev: each Agent tool subagent, a
teammate, a plugin's `$.agent.spawn`, and each `agent()` call of a Workflow
script, which is how a whole workflow's fan-out (an ultracode run's
implementers, reviewers and verifiers) ends up routed one agent at a time.
The `routeSubagents` setting turns this off; the main loop is routed either
way.

The hook is `agent.spawn`, the one place the engine lets a model be set for
every kind of agent. Jev is asked about the brief, not about your last
message: the state is the brief itself, the short description its caller
gave, the subagent's type and whether a workflow script sent it, with your
latest request beside a brief too thin to judge (`briefStateOf` in
`hooks/state.ts`; the fields are in [What Jev is shown](#what-jev-is-shown)).
The question's wording changes with it: Jev is told a coding agent is handing
this task to a subagent that will carry it out alone, without anyone to ask.
Where unclear work goes is said once, on the default pair, as for a turn.

Jev's pick **overrides whatever model the caller named**: the Agent tool's
`model` parameter, an agent definition's own model, a workflow script's
`opts.model`. That is the point. The row in `/jev` keeps what was asked for,
`asked claude-fable-5-1 → opus·high`, so the override is visible. The
confidence floor and the Fable gate apply; stickiness does not. The effort
comes out of the same answer, by the same rule as on the main loop: the
likeliest of the picked family's pairs, or the whole answer's median effort
when that family holds under half of it.

The spawn can set the model but not the effort, so the decision is kept and
applied in `turn.step`, at each of the subagent's requests, model and effort
together, re-clamped into the bands of that moment. The step rewrite is also what holds where the session forces one
model on every subagent, which outranks a spawn hook's choice.

A subagent's loop can begin before the spawn hook hears its id back, so the
spawn leaves its decision in a queue keyed by its prompt before it goes down
the chain, and the agent's first `turn.start` (or, failing that, its first
step, read by the loop's first message) takes one entry off it. Once the spawn
answers, the decision is kept by agent id. The queue is one-shot: parallel
spawns with the same prompt, a workflow's judges say, each end with exactly
one entry of their own, and once the last spawn with that prompt has
answered, anything left in its queue is dropped, so a fork that later starts
with a matching prompt inherits nothing. The router does not depend on a
subagent's `turn.start` firing (an older engine, probed live, sent none); when
it does fire, it is tied to the spawn's decision and Jev is not asked again.

Entries for one prompt are not interchangeable: a security audit and a TODO
list can share a prompt and get `opus·max` and `haiku·medium`, and a fork beside a
routed sibling must keep its parent's model. So a loop only takes an entry
that is its own, or one that would run it exactly alike. It narrows the queue
by its list row's type and description, and at a step by the model the step
arrived on, which its spawn chose. If what is left still differs, its
`turn.start` takes nothing and waits: the spawn's answer binds it by id, or
its first step does by model.

The router's lookups, and the `/jev` switches, live in the host's `$.state`
as well as in memory, because a change to any setting in the config menu
reloads the module from nothing. Without that, a teammate routed to Opus
before the reload would be asked about again on the one-line message that
wakes it after, and probably put on Haiku mid-task. A decision read back
after a reload is clamped into the bands in force then. One an 0.2 copy kept,
in the fixed-rung shape, is read as the family and effort it ran on:
`opus-high` as `opus·high`, `opus-max` as `opus·max`, `sonnet-medium` and
`sonnet-high` as Sonnet at that effort, and a kept `haiku` at `low` as
`haiku·medium`. One naming a tier neither ladder knows is dropped, and that
agent's steps run as the engine sent them, under the Fable guard.

What a turn is bound to lasts as long as the turn: its decision, the lookup
from it to its row, and its pending route line are dropped at its
`turn.complete`; the row itself stays in the history. That is how a
workflow fanning out to forty agents keeps the main turn that launched it, and
its first agents, routed and reporting while every one of them runs; the
lookups used to hold 32 entries and drop the oldest, which in a fan-out were
turns still running. An agent's own decision outlives its turn, since a
message can wake its loop for another one; those are kept most recently used
last. The per-turn and per-agent lookups have a backstop of 1024 entries, as
a leak guard only.

A loop the engine starts with no `agent.spawn` at all, a forked skill say, is
asked about at its first `turn.start`, from the text it began with, the way a
subagent's brief is, and the answer is bound to that turn and agent. That is
only for a loop `$.agent.list()` names as a subagent. A teammate the router
never saw spawn (one started while `/jev` was off) is not asked about: the
text its turn starts with is the message that woke it, not its task. Nor is a
loop the list does not name at all, such as a workflow agent's retry after a
stall or an engine fork, which carries nothing describing what it does.
Under `routeSubagents` off none is asked about. Each shows as an unrouted
row, and its steps are still under the Fable guard.

A step the engine itself moved to another model (a fallback after a refusal
or an overload) goes on the model the engine resolved, rather than back to
the decision's model, which is the one that just failed. It is still under
the Fable guard, and its effort is still held to that model's band.

Three kinds of agent are not asked about:

- **A fork** inherits its parent's context, and its parent's cache with it.
  Moving it to another model would throw that cache away on its first request,
  which costs more than any cheaper model saves, and the engine ignores a fork's model
  anyway. It runs on what it inherited, unless the Fable setting refuses that,
  with its effort held to its model's band.
- **A resume** continues a run that already has its model, and the engine
  ignores a changed model on one. A run this session routed keeps its
  decision; one it did not runs on what it had, unless the Fable setting
  refuses that.
- **Any subagent while `routeSubagents` is off**, which runs on what it was
  given.

All show in `/jev` as unrouted rows, and all are under the Fable guard and
the bands at every step.

Each new subagent waits for Jev before it starts, up to the timeout, and costs
one Jev call. A failure is the same as on the main loop: the agent runs on
the default, `opus·high` unless you set another. With no key set nothing is
asked and nothing is touched, Fable
included (see [When Jev cannot answer](#when-jev-cannot-answer)).

Some workflow runs keep their script out of SDK events and hand `agent.spawn`
a fixed placeholder instead of the real prompt; the agent starts with the
script's own. A spawn whose prompt an earlier spawn of the same run already
carried is taken for that placeholder: Jev is not asked at the spawn, and the
agent is asked about at its first `turn.start`, from the prompt its loop
actually began with. The first spawn of such a run cannot know, so it is
asked about at the spawn and again at its first turn when its loop opens
with something else. A script that really gives two agents one prompt costs
nothing extra by this: each is asked once, at its first turn.

## Checking and tuning

```
npm run check-jev        # is the configured provider serving?
npm run try-prompts      # what family and effort does Jev give a spread of prompts?
npm run try-prompts -- "your prompt"
npm run try-prompts -- --fable=hardest
npm run try-prompts -- --dry-run
JEV_ROUTER_OPUS_EFFORT=high npm run try-prompts    # the same, on a narrower band
```

`check-jev` prints the Fable mode in force and where it came from, the
families and pairs that mode offers and the default, then detects which
provider is configured and runs the appropriate diagnostic. For the gateway
it checks credits; for TypeSafe direct it makes a live call. The probe is the
request the hooks really send, the `route` question over the offered pairs,
worded for the mode, about a first turn's state, so a pass means the live
shape is accepted, and it prints the pair Jev named, the family·effort it
comes to, Jev's probability on each family with the share behind what would
run, and, when the floor or the Fable gate would move it, where it would run
instead.

`try-prompts` is the tuning loop: edit `criteriaOf` (the kind of work each
family takes) or `THINKING` (how hard each effort thinks) in `policy.ts`,
or `ASK_INSTRUCTIONS` in `jev.ts`, run it, and see whether the picks moved
the way you wanted. It tries eleven typed turns and six subagent briefs, the
turns built through `turnStateOf` and the briefs through `briefStateOf`, so
Jev sees the fields the hooks would send (a turn here has no session around
it, so it is the request alone). It reads the settings the way the router
does (env var, then the `pluginConfigs` options, then the default) and
honours `JEV_ROUTER_EXCLUDE`, and prints the settings, the default, the
offered ladder with each family's band, and the pairs, before it asks
anything. `--fable=never|hardest|open` overrides the mode for that run,
which is how to see what a ladder with Fable on it would pick before turning
it on. `--dry-run` prints each request's instructions and state and its
size, and calls nothing.

Both scripts take the eleven settings from the shell over the `env` block of
settings.json, and everything else, the keys included, from the `env` block
alone. Neither ever prints the key.

Its columns:

```
  ms  kind      top            runs                         cum  prompt
      family: haiku 0.59 (0.59) · sonnet 0.41 (1.00) · opus 0.00 (1.00)
      pairs:  haiku_medium 0.52 · haiku_high 0.07 · sonnet_high 0.41
```

`top` is the pair Jev named; `runs` is what would actually run once the
floor and the Fable gate have had their say, marked `floored:<family>`,
`capped` or `fallback` when the family differs from the top pair's; `cum`
is the share of Jev's probability behind what runs. Under each row, Jev's
probability per family with the running total the floor reads in brackets,
and per pair, so a split the top pair hides is there to read. Both come from
`routedDecisionOf`, the function the hooks settle a turn with. Stickiness is
left out, since it depends on the previous turn rather than the prompt.

```
node scripts/eval/compare.mjs              # the shipped design against the recorded previous one
node scripts/eval/compare.mjs --dry-run    # the shipped requests, nothing called
node scripts/eval/compare.mjs --only=id1,id2
```

`compare.mjs` asks the shipped request, live, for each case in
`scripts/eval/cases.json`, and decides the previous design from its
answers recorded in `scripts/eval/ab-results.json`, through the same
`routedDecisionOf` (which still reads the old answer shape), so the previous
column is exactly what shipped before and costs nothing to rerun. It prints
both designs per case with Jev's family and pair shares, accuracy overall
and per class, and the paired comparison with an exact McNemar p, which is
the number that says whether a difference is more than noise. A case can
carry `messages` and `cwd` (a turn) or `parentRequest` (a brief) to
exercise the state fields; the recorded cases carry none, so on them the
comparison measures the question alone. Each run's results, every request as
sent, go to `scripts/eval/results/`, which git ignores. It reads
`TYPESAFE_API_KEY` and spends one call per case.

## When Jev cannot answer

A router that cannot be asked must not cost more than no router, and one that
fails once must not land on whatever the session happens to be set to. So
there are two cases.

**No key configured** (no `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, or
`JEV_ROUTER_PROVIDER` naming one whose key is unset) is routing off, exactly
as `/jev off` is. No request is made and nothing is touched: no fallback to
the default, no Fable clamp, no route line, on the main loop and on every
subagent. `/jev` says routing is off because no key is set, and how to set
one. Setting a key mid-session turns routing on from the next turn; the
router reads the env fresh each time.

**A key that is there and a call that failed this once** runs that turn, or
that subagent, on the default, `opus·high` unless `defaultModel` and
`defaultEffort` say otherwise, with the reason kept, and the Fable guard
holds as usual:

- the provider takes longer than the timeout (1500ms by default)
- the provider refuses the key, errors, or returns a body we cannot read
- the call throws on the way (shown as `router error: …`)
- Jev's answer puts no probability on an offered pair and names none
  (an old rung name such as `opus-high` included)
- there is no text to ask about: a spawn outside a workflow with no prompt,
  description or subagent type

A main-loop turn with no text at all (a continuation) is not a failure and
is not asked about: it carries on, on the family and effort the turn before
it ran on.

The cost of a failure is the latency spent waiting, capped at the timeout, and
a turn on the default where a cheaper one might have done. The router never blocks or
refuses a turn or a spawn.

A fallback announces itself, with the reason:

```
> ⚠️ `opus·high` · fallback — gateway said HTTP 403 (customer_verification_required)
```

A split answer is not a failure. The floor picks the cheapest family enough
of Jev's probability backs, marked `floored:<family>` when that is above
the family of Jev's top pair, and a Fable pick with too little on Fable goes to Opus at
the top of its band, `opus·max` by default, marked `capped:fable`. A `?`
after the percentage (`haiku·medium · 42%?`) marks a pick with under half of
Jev's probability behind it, which at the default floor only a decision kept
from before this rule, a choice-only answer, or a floor set below 0.5, can
show.

## Layout

```
hooks/register.ts   the hooks, the per-turn and per-agent lookups, the history
hooks/config.ts     the eleven settings: env var, then plugin option, then default
hooks/jev.ts        the request shape, timeout, named failures
hooks/state.ts      what Jev is shown: a turn's or a brief's named fields, the budget
hooks/provider.ts   which backend (TypeSafe direct or gateway) to use
hooks/policy.ts     the families and default bands, the ladder from the settings,
                    the criteria per Fable mode and per effort, the pairs,
                    answers → decision, family first (pairPickOf), the Fable gate,
                    the hold, the Fable guard
hooks/label.ts      decision → the words every surface names it by
hooks/status.ts     the per-turn line, what /jev prints, usage per turn
types/index.d.ts    the plugin's contract: what it keeps in $.state
tests/              node:test suites; register.test.ts drives the real hooks
                    with a fake engine and asserts the stream transform
scripts/            check-jev and try-prompts, for setup and tuning
scripts/eval/       compare.mjs, its labeled cases, and the recorded A/B run
```

`jev.ts` takes `fetch` and `sleep` as arguments rather than importing them, so
the tests run with no engine and no network. `state.ts` is pure too: the
hooks read the transcript and the directory and hand them in as plain data.
`provider.ts` and `config.ts` are
pure: they take environment variables (and, for `config.ts`, the plugin's
options) and return what to use, with nothing left to look up.

## Working on it

```
node --test tests/*.test.ts
npx tsc -p .
claude plugin validate .
```

Unquoted, so the shell expands the glob. `npm test` quotes it for node to
expand, which does not happen on Windows.

`plugin validate` is worth running on every change. It does static analysis and
prints every event the module hooks, everything it calls on `$`, and every
environment variable it reads or writes, without executing anything. It also
catches shape errors that are easy to get wrong, such as `turn.step` needing to
be an `async function*` because it streams, and it checks the `userConfig`
block against the schema the engine accepts. Two of its rules shape
`register.ts`: every `$.env.get` names its variable literally, so the four
settings are read one by one rather than looped over `CONFIG_ENV_KEYS`, and a
function that is handed `$` is declared at the top level of the file. The
second is why the router's state is one `Router` object the top-level
functions take, rather than variables `register` closes over.

Claude Code 2.1.312 has `claude plugin test`, which runs a plugin's
`*.test.ts` files against the engine itself through the `claude-code/testing`
kit. The suites here predate it and are plain `node:test` with a fake engine,
so run them with `node --test`.

## Backends

Both backends speak the same `choice` and `score` question types and the same
`answers` response shape, so the request/response handling is identical.

**TypeSafe direct** endpoint: `POST https://api.typesafe.ai/v1/systemone`.
Bearer auth, body is `{ model: "jev-latest", state, questions }`. Probabilities
and confidences come back rounded to four decimal places. Supports all three
question types: `choice`, `score`, and `noul`.

**Vercel AI Gateway** endpoint: `POST https://ai-gateway.vercel.sh/v1/evaluate`.
Bearer auth, body is `{ model, state, questions }` (the gateway ignores the
model field). Probabilities and confidences come back rounded to two decimal
places. Only supports `choice` and `score` — the gateway rejects `noul` outright.
