/**
 * Checks whether Jev (either TypeSafe direct or Vercel AI Gateway) will serve requests.
 *
 * Determines which provider is configured and runs the appropriate diagnostic.
 * For the gateway, checks credits. For TypeSafe direct, makes a live call.
 *
 * The probe is the request jev-router really sends, built by requestBodyOf
 * from hooks/jev.ts: one `route` choice over the model·effort pairs the
 * person's settings offer (each family's band), worded for their Fable
 * mode, about a first turn's state as turnStateOf builds it (named fields,
 * the request alone). A passing check therefore means the live shape is
 * accepted, not just that the key works.
 *
 * It also prints the Fable mode in force and where it came from, read the
 * way `configOf` reads it (the env var, then the plugin's options under
 * `pluginConfigs` in settings.json, then the default), because "why did
 * that run on Fable" and "why is Fable never offered" are both answered
 * there before they are answered anywhere else. The default the ladder
 * falls back to is printed beside it, read the same way, and the probe's
 * answer is clamped into the bands the settings give each family.
 *
 * Run it after changing anything on the TypeSafe or Vercel side:
 *
 *   npm run check-jev
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { CONFIG_ENV_KEYS, configOf } from '../hooks/config.ts'
import { requestBodyOf } from '../hooks/jev.ts'
import {
  ceilingOf,
  decisionOf,
  excludedTiers,
  familyOf,
  familySharesOf,
  gatedDecision,
  ladderOf,
  offeredPairs,
  offeredTiers,
  pairSharesOf,
} from '../hooks/policy.ts'
import { PROVIDER_ENV_KEYS } from '../hooks/provider.ts'
import { turnStateOf } from '../hooks/state.ts'
import { configSourcesOf } from '../hooks/status.ts'

/** settings.json, or nothing when there is none: a shell key is enough. */
function readSettings() {
  try {
    return JSON.parse(readFileSync(`${homedir()}/.claude/settings.json`, 'utf8'))
  } catch {
    return {}
  }
}

const settings = readSettings()

/**
 * The env as a session would see it: the shell's value over the `env`
 * block. The keys come from the shell too, because `$.env.get` reads the
 * process environment, so a key exported in the shell is the one the mod
 * uses and the one this check must try.
 */
const env = { ...(settings?.env ?? {}) }
for (const key of [...CONFIG_ENV_KEYS, ...PROVIDER_ENV_KEYS]) {
  if (process.env[key] !== undefined) env[key] = process.env[key]
}

/**
 * The plugin's stored options: `pluginConfigs[<plugin>].options`, keyed
 * `jev-router` (or `jev-router@inline`) for a --plugin-dir plugin,
 * `jev-router@<marketplace>` for an installed one.
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
const config = configOf(options, env)
const sources = configSourcesOf(options, env)
const ladder = ladderOf(config)
const offered = offeredTiers(
  excludedTiers(env.JEV_ROUTER_EXCLUDE, ladder),
  config.fable,
  ladder,
)

const { tier: ceilingTier, effort: ceilingEffort } = ceilingOf(ladder)
const ceiling = `${ceilingTier}·${ceilingEffort}`
const fableNote = {
  never: `${ceiling} is the ceiling, Fable is never offered`,
  hardest:
    `offered; a pick needs ${Math.round(config.fableConfidence * 100)}% ` +
    `(${sources.fableConfidence}) of Jev's probability on fable, else ${ceiling}`,
  open: 'an ordinary family',
}[config.fable]
console.log(`fable          ${config.fable} (${sources.fable}) — ${fableNote}`)
console.log(`offered        ${offered.join(', ')}`)
console.log(`pairs          ${offeredPairs(offered, ladder).join(' ')}`)
console.log(
  `default        ${ladder.defaultTier}·${ladder.defaultEffort} ` +
    `(model ${sources.defaultModel}, effort ${sources.defaultEffort})`,
)
const tsKey = env.TYPESAFE_API_KEY
const gwKey = env.AI_GATEWAY_API_KEY
const forced = (env.JEV_ROUTER_PROVIDER ?? '').toLowerCase()

// Determine which provider is active
let provider = null
let activeKey = null

if (forced === 'typesafe') {
  if (!tsKey) {
    console.error('JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set.')
    process.exit(1)
  }
  provider = 'typesafe'
  activeKey = tsKey
} else if (forced === 'gateway') {
  if (!gwKey) {
    console.error('JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set.')
    process.exit(1)
  }
  provider = 'gateway'
  activeKey = gwKey
} else {
  // Default precedence
  if (tsKey) {
    provider = 'typesafe'
    activeKey = tsKey
  } else if (gwKey) {
    provider = 'gateway'
    activeKey = gwKey
  } else {
    console.error('No TYPESAFE_API_KEY or AI_GATEWAY_API_KEY in the shell or ~/.claude/settings.json.')
    process.exit(1)
  }
}

const fingerprint = createHash('sha256')
  .update(activeKey)
  .digest('hex')
  .slice(0, 12)
console.log(`provider       ${provider}`)
console.log(`key            ${activeKey.length} chars, sha256[:12]=${fingerprint}`)

/** The probe body for a provider's model, exactly as the hooks would send it. */
const probeBodyOf = model =>
  JSON.stringify({
    ...requestBodyOf(
      turnStateOf({ request: 'what is 2+2' }),
      offered,
      'turn',
      config.fable,
      ladder,
    ),
    model,
  })

/**
 * What Jev's `route` answer comes to as family·effort. A 200 whose answer
 * names no offered pair still routes nothing: every turn would fall back
 * to the default. `d` is the family with the most of Jev's probability
 * at its likeliest pair, or at the whole answer's median effort (kept in
 * the family's band) when the family holds under half of it; a pick the settings move (the floor's cumulative
 * family share taking it up, a Fable pick short of the Fable bar capped)
 * says where it would run instead. The shares are printed per family, the
 * pairs' added up, since that is what the floor reads; an answer with no
 * probabilities is said so, since the floor then has nothing to read and
 * the choice is taken as it stands.
 */
const pickOf = answer => {
  const route = answer?.answers?.route
  const d = decisionOf(answer?.answers, offered, ladder, 0)
  if (!d) {
    return `no usable pair in "${route?.choice}", so turns would fall back`
  }
  const floored = decisionOf(answer?.answers, offered, ladder, config.minConfidence) ?? d
  const runs = gatedDecision(floored, config, ladder)
  const pairShares = pairSharesOf(route?.probabilities, offeredPairs(offered, ladder))
  const shares = pairShares
    ? Object.entries(familySharesOf(pairShares))
        .map(([t, p]) => `${t} ${p.toFixed(2)}`)
        .join(' ')
    : 'NO probabilities'
  const moved =
    runs.tier === d.tier && runs.effort === d.effort
      ? ''
      : `, would run ${familyOf(runs.tier)}·${runs.effort}` +
        `${runs.capped ? ' capped' : ''}${runs.floored ? ' floored' : ''}`
  return (
    `Jev answered "${route?.choice}" (${familyOf(d.tier)}·${d.effort}, ` +
    `${shares}, ${Math.round(runs.confidence * 100)}% says ${runs.tier} or cheaper` +
    `${moved})`
  )
}

if (provider === 'gateway') {
  // Gateway: check credits first
  const auth = { authorization: `Bearer ${activeKey}` }

  const credits = await fetch('https://ai-gateway.vercel.sh/v1/credits', {
    headers: auth,
  })
  const balance = credits.ok ? await credits.json() : null

  if (!credits.ok) {
    console.log(`credits        HTTP ${credits.status} — the key itself is not being accepted`)
    process.exit(1)
  }

  console.log(`credits        balance ${balance.balance}, used ${balance.total_used}`)

  // Gateway: make an evaluate call
  const probe = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: probeBodyOf('typesafe-ai/jev'),
  })

  const text = (await probe.text()).replaceAll(activeKey, '<REDACTED>')

  if (probe.ok) {
    const answer = JSON.parse(text)
    console.log(`evaluate       HTTP 200 — ${pickOf(answer)}`)
    console.log('\nThe gateway is serving. jev-router will route.')
    process.exit(0)
  }

  console.log(`evaluate       HTTP ${probe.status}`)
  console.log(text.slice(0, 400))

  if (Number(balance.balance) === 0) {
    console.log(
      '\nBalance is 0, so this account has never been granted credits. ' +
        'Whatever card was added went to a different Vercel scope than the one ' +
        'this key belongs to. Add it to this scope, or make a new key under the ' +
        'scope that has the card.',
    )
  }
  process.exit(1)
} else {
  // TypeSafe direct: make a systemone call
  const auth = { authorization: `Bearer ${activeKey}` }
  const base = (env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/$/, '')

  const probe = await fetch(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: probeBodyOf('jev-latest'),
  })

  const text = (await probe.text()).replaceAll(activeKey, '<REDACTED>')

  if (probe.ok) {
    const answer = JSON.parse(text)
    console.log(`systemone      HTTP 200 — ${pickOf(answer)}`)
    console.log('\nTypeSafe direct is serving. jev-router will route.')
    process.exit(0)
  }

  console.log(`systemone      HTTP ${probe.status}`)
  console.log(text.slice(0, 400))
  process.exit(1)
}
