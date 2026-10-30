/**
 * Shows the family and effort Jev picks for a spread of prompts, using the
 * real policy from hooks/policy.ts, the real request from hooks/jev.ts and
 * the real state from hooks/state.ts. This is the tuning loop: edit the
 * wording in policy.ts (`criteriaOf` for the kind of work each family
 * takes, `THINKING` for how hard each effort thinks; each option of the
 * one `route` question is the two composed) or the instructions in
 * jev.ts, run this, see whether the picks moved the way you wanted.
 *
 * Two kinds of prompt are tried, because the hooks ask two ways: a turn a
 * developer typed into the main session, and a brief a coding agent handed
 * to a subagent (an Agent tool call, or a workflow script's agent()). A
 * turn goes through turnStateOf and a brief through briefStateOf, so Jev
 * sees the named fields the hooks would send; a turn here has no session
 * around it, so it is a first turn's state, the request alone.
 *
 * `top` is Jev's top pair as it named it (`sonnet_high`). `runs` is what
 * the turn would actually run on: the family the floor reads off Jev's
 * probabilities, each family's pairs added up (the cheapest family with at
 * least `minConfidence` of them on it or cheaper), at the likeliest of
 * that family's pairs, or at the whole answer's median effort when the
 * family holds under half of it, after the Fable gate, marked `floored` when the
 * family is above the top pair's and `capped` when the Fable bar sent it
 * to Opus. `cum` is the share of Jev's probability behind what runs,
 * P(family <= it), the number the footer prints. The lines under each row
 * are Jev's probability on each family offered, with the running total
 * the floor reads, and on each pair, so a split the top pair hides is
 * there to read. The answer's own `confidence` is not shown: TypeSafe
 * defines it as how concentrated the answer is, not how likely it is to be
 * right, and the router does not read it. A failed call shows the
 * fallback, because that is what the hooks do with one: run the ladder's
 * default, Opus at high effort unless the settings name another. Both go
 * through `routedDecisionOf` from hooks/status.ts, the same function the
 * hooks settle a turn with, so the column cannot drift from what a session
 * would do. Stickiness is left out; it depends on the previous turn, not
 * the prompt.
 *
 * The settings are the router's own, read the way `configOf` reads them:
 * the env var, then the plugin's options (`pluginConfigs` in settings.json),
 * then the default. The env vars come from the shell first and the `env`
 * block of settings.json second. `--fable=never|hardest|open` overrides the
 * Fable mode for one run, which is how to see what a ladder with Fable on
 * it would do before turning it on for real. The default model, the
 * default effort and each family's band are read the same way
 * (`JEV_ROUTER_DEFAULT_MODEL`, `JEV_ROUTER_OPUS_EFFORT` and the rest), so
 * a narrower band can be tried for one run with an env var. The header
 * prints the settings in force and the ladder Jev is offered under them.
 *
 *   npm run try-prompts
 *   npm run try-prompts -- "your own prompt here"
 *   npm run try-prompts -- --fable=hardest
 *   npm run try-prompts -- --dry-run      (print the requests, call nothing)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import {
  BAND_SETTING,
  CONFIG_ENV_KEYS,
  configOf,
  FABLE_MODES,
} from '../hooks/config.ts'
import { askJev, requestBodyOf } from '../hooks/jev.ts'
import {
  excludedTiers,
  familyOf,
  familySharesOf,
  ladderOf,
  modelOf,
  offeredPairs,
  offeredTiers,
  pairSharesOf,
  shareUpTo,
} from '../hooks/policy.ts'
import { briefStateOf, turnStateOf } from '../hooks/state.ts'
import { PROVIDER_ENV_KEYS, providerOf } from '../hooks/provider.ts'
import { configSourcesOf, routedDecisionOf, routeOf } from '../hooks/status.ts'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const FABLE_FLAG = /^--fable=(.*)$/
const fableFlag = args.map(a => a.match(FABLE_FLAG)?.[1]).find(v => v !== undefined)
const own = args.filter(a => a !== '--dry-run' && !FABLE_FLAG.test(a))

// A mistyped mode is refused rather than read as the default: a run that
// quietly tried "never" when "hardest" was asked for would answer the wrong
// question with confidence.
if (fableFlag !== undefined && !FABLE_MODES.includes(fableFlag.trim().toLowerCase())) {
  console.error(`--fable takes one of ${FABLE_MODES.join(', ')}, not "${fableFlag}".`)
  process.exit(1)
}

const readSettings = () => {
  try {
    return JSON.parse(readFileSync(`${homedir()}/.claude/settings.json`, 'utf8'))
  } catch (error) {
    if (dry) return {}
    throw error
  }
}
const settings = readSettings()

/**
 * The router's env vars as a session would see them: the shell's over the
 * `env` block of settings.json. The keys and the provider switches come
 * from the shell too, because `$.env.get` reads the process environment:
 * a key exported in the shell is the key the mod uses, so it is the key
 * this run must use.
 */
const env = { ...(settings?.env ?? {}) }
for (const key of [...CONFIG_ENV_KEYS, ...PROVIDER_ENV_KEYS]) {
  if (process.env[key] !== undefined) env[key] = process.env[key]
}

/**
 * The plugin's stored options, where the engine keeps them:
 * `pluginConfigs[<plugin>].options`, keyed `jev-router` (or
 * `jev-router@inline`) for a --plugin-dir plugin, `jev-router@<marketplace>`
 * for an installed one.
 */
const optionsOf = configs => {
  const keys = Object.keys(configs ?? {})
  const key =
    keys.find(k => k === 'jev-router') ??
    keys.find(k => k === 'jev-router@inline') ??
    keys.find(k => k.startsWith('jev-router@'))
  return key === undefined ? undefined : configs[key]?.options
}
const options = optionsOf(settings?.pluginConfigs)

// The flag outranks everything, the env var included, for this run only.
const config = configOf(
  options,
  fableFlag === undefined ? env : { ...env, JEV_ROUTER_FABLE: fableFlag },
)
const sources = {
  ...configSourcesOf(options, env),
  ...(fableFlag === undefined ? {} : { fable: 'flag' }),
}

const provider = providerOf({
  TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
  AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY,
  JEV_ROUTER_PROVIDER: env.JEV_ROUTER_PROVIDER,
  TYPESAFE_BASE_URL: env.TYPESAFE_BASE_URL,
})

if (!provider.ok && !dry) {
  console.error(`Provider error: ${provider.reason}`)
  process.exit(1)
}

// The bands and the default, as the hooks build them from the same settings.
const ladder = ladderOf(config)
const offered = offeredTiers(
  excludedTiers(env.JEV_ROUTER_EXCLUDE, ladder),
  config.fable,
  ladder,
)
// No `sticky`: a hold depends on the turn before, not on the prompt.
const route = routeOf(config)

/** The pairs Jev is offered under these settings, cheapest family first. */
const pairs = offeredPairs(offered, ladder)

/** A turn typed into the main session, as a first turn's state. */
const turn = text => ({
  kind: 'turn',
  text,
  asking: 'turn',
  state: turnStateOf({ request: text }),
})

/** A brief handed to a subagent, as the agent.spawn hook would see it. */
const subagent = ({ prompt, description, subagentType, workflow = false }) => ({
  kind: workflow ? 'workflow' : 'agent',
  text: description ?? prompt,
  asking: 'subagent',
  state: briefStateOf({ prompt, description, subagentType, workflow }),
})

const DEFAULTS = [
  turn('what is 2+2'),
  turn('what does this function return'),
  turn('rename the variable foo to bar in utils.ts'),
  turn('add a --verbose flag to the CLI'),
  turn('write a test for the pagination helper'),
  turn('implement cursor pagination for the reports endpoint'),
  turn('refactor the auth module to use the new session interface'),
  turn('the e2e suite passes alone but fails when run with the others, work out why'),
  turn('help me plan the architecture for multi-tenant billing'),
  turn('should we use event sourcing here or is that overkill'),
  turn(
    'the ledger drifts by a few cents a week under production load and two ' +
      'rounds of debugging found nothing; work out where the money goes',
  ),

  subagent({
    subagentType: 'Explore',
    description: 'Find config loader',
    prompt:
      'Find the file that loads config.yaml and report its path and the ' +
      'name of the exported function. Do not change anything.',
  }),
  subagent({
    subagentType: 'general-purpose',
    description: 'Bump timeout constant',
    prompt:
      'In src/http/client.ts, change DEFAULT_TIMEOUT_MS from 5000 to 8000. ' +
      'Nothing else. Reply with the diff.',
  }),
  subagent({
    subagentType: 'general-purpose',
    description: 'Add retry test',
    prompt:
      'Write one node:test case in tests/retry.test.ts showing that ' +
      'withRetry() gives up after three failures. Use the existing fakeClock ' +
      'helper in tests/helpers.ts. Run the tests and report the result.',
  }),
  subagent({
    subagentType: 'general-purpose',
    description: 'Implement token refresh',
    workflow: true,
    prompt:
      'Implement refresh-token rotation in the auth service: the refresh ' +
      'endpoint, revoking the old token, the migration for the new column, ' +
      'and tests. Follow the session interface in src/auth/session.ts. Do ' +
      'not commit. Return files changed and test results.',
  }),
  subagent({
    subagentType: 'general-purpose',
    description: 'Verify race fix',
    workflow: true,
    prompt:
      'Another agent claims the double-charge race in payments/capture.ts ' +
      'is fixed. Try to break the fix: find any interleaving of the webhook ' +
      'handler and the retry worker that still captures twice. Report ' +
      'CONFIRMED or REFUTED with the interleaving.',
  }),
  subagent({
    subagentType: 'Plan',
    description: 'Plan sharding',
    prompt:
      'Design how to shard the events table by tenant without downtime. ' +
      'Weigh online migration against dual writes, and say which and why.',
  }),
]

const prompts = own.length ? own.map(turn) : DEFAULTS
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Jev's probability per family, each family's pairs added up, with the
 * running total the floor reads (`haiku 0.59 (0.59) · sonnet 0.41 (1.00)`),
 * and on a second line the pairs themselves, renormalised over the ones
 * offered, those Jev gave next to nothing left out. Says so when there are
 * none, since the floor then takes the choice as it stands.
 */
const sharesLines = answers => {
  const shares = pairSharesOf(answers?.route?.probabilities, pairs)
  if (!shares) return ['NO probabilities, the choice is taken as it stands']
  const families = familySharesOf(shares)
  const family =
    'family: ' +
    offered
      .map(t => `${t} ${(families[t] ?? 0).toFixed(2)} (${shareUpTo(shares, t).toFixed(2)})`)
      .join(' · ')
  const pair =
    'pairs:  ' +
    pairs
      .filter(p => (shares[p] ?? 0) >= 0.005)
      .map(p => `${p} ${shares[p].toFixed(2)}`)
      .join(' · ')
  return [family, pair]
}

/** `opus·high`, the way the footer writes a decision. */
const rungOf = d => `${familyOf(d.tier)}·${d.effort}`

/**
 * The settings in force and the ladder they offer, printed before anything
 * is asked, so a surprising pick can be read against what was on the table.
 */
const printSettings = () => {
  const bar =
    config.fable === 'hardest'
      ? `, a pick needs ${Math.round(config.fableConfidence * 100)}% (${sources.fableConfidence}) on fable`
      : ''
  const floor =
    config.minConfidence === 0
      ? "off, Jev's top choice"
      : `a pick needs ${Math.round(config.minConfidence * 100)}% of Jev's probability on its model or cheaper`
  console.log(`fable     ${config.fable} (${sources.fable})${bar}`)
  console.log(`floor     ${floor} (${sources.minConfidence})`)
  console.log(
    `agents    ${config.routeSubagents ? 'routed' : 'not routed in a session'} (${sources.routeSubagents})`,
  )
  const refused =
    ladder.refusedTier !== undefined
      ? `, ${ladder.refusedTier} refused under ${config.fable}`
      : ''
  const clamped =
    ladder.clampedEffort !== undefined
      ? `, ${ladder.clampedEffort} clamped into its band`
      : ''
  console.log(
    `default   ${ladder.defaultTier}·${ladder.defaultEffort} ` +
      `(model ${sources.defaultModel}, effort ${sources.defaultEffort})${refused}${clamped}`,
  )
  const width = Math.max(...offered.map(t => t.length))
  const modelWidth = Math.max(...offered.map(t => modelOf(t).length))
  offered.forEach((tier, i) => {
    const { min, max } = ladder.bands[tier]
    const range = min === max ? min : `${min}–${max}`
    const tag =
      tier === ladder.defaultTier ? `  (default: ${ladder.defaultEffort})` : ''
    console.log(
      `${i === 0 ? 'ladder    ' : '          '}${tier.padEnd(width)}  ` +
        `${modelOf(tier).padEnd(modelWidth)}  ${range} ` +
        `(${sources[BAND_SETTING[tier]]})${tag}`,
    )
  })
  console.log(`pairs     ${pairs.join(' ')}`)
  console.log('')
}

printSettings()

if (dry) {
  for (const p of prompts) {
    const body = requestBodyOf(p.state, offered, p.asking, config.fable, ladder)
    console.log(`── ${p.kind}: ${p.text}`)
    console.log(JSON.stringify(body.questions.route.instructions))
    console.log(JSON.stringify(body.state))
    console.log(
      `state ${JSON.stringify(body.state).length} chars, ` +
        `${Object.keys(body.questions.route.criteria).length} pairs offered, ` +
        `request ${JSON.stringify(body).length} chars\n`,
    )
  }
  process.exit(0)
}

console.log('  ms  kind      top            runs                         cum  prompt')
console.log('  ──  ────────  ─────────────  ───────────────────────────  ────  ──────')

for (const p of prompts) {
  const result = await askJev({
    fetch: async (url, init) => {
      const r = await fetch(url, init)
      return { ok: r.ok, status: r.status, text: await r.text() }
    },
    sleep,
    provider,
    state: p.state,
    offered,
    asking: p.asking,
    fable: config.fable,
    ladder,
    timeoutMs: 10_000,
  })
  // Jev's top pair as it named it; `d` is what the floor makes of the
  // whole distribution.
  const d = routedDecisionOf(result, offered, route)
  const named = result.ok ? result.answers?.route?.choice : undefined

  const short = p.text.length > 56 ? `${p.text.slice(0, 53)}...` : p.text
  const top = typeof named === 'string' ? named : result.ok ? 'NO PAIR' : 'FAILED'
  const runs =
    `${rungOf(d)}${d.capped ? ' capped' : ''}${d.floored ? ` floored:${d.floored}` : ''}` +
    `${d.fallback ? ' fallback' : ''}`
  console.log(
    `${String(result.ms).padStart(4)}  ${p.kind.padEnd(8)}  ${top.padEnd(13)}  ` +
      `${runs.padEnd(27)}  ${d.confidence.toFixed(2)}  ${short}`,
  )
  if (d.fallback) console.log(`      ${d.fallback}`)
  else for (const line of sharesLines(result.answers)) console.log(`      ${line}`)
}
