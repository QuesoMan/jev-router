/**
 * Compares the shipped way of asking Jev for a route against the previous
 * one, over the same labeled cases.
 *
 *   previous  a Choice `tier` over the families plus a Score `effort` over
 *             five effort levels, with the request alone (or a brief's
 *             header lines) as text. Not asked again: its answers are the
 *             ones recorded in ab-results.json when the comparison that
 *             chose the shipped design ran (2026-10-30, jev-1.14.0), and
 *             they are decided here by the hooks' own `routedDecisionOf`,
 *             which still reads that shape (`legacyDecisionOf`), on the
 *             default config. So "previous" is exactly what shipped before.
 *
 *   shipped   one Choice `route` over the model·effort pairs the ladder
 *             allows, worded by policy.ts, about the state hooks/state.ts
 *             builds (named fields), asked live through requestBodyOf and
 *             decided by routedDecisionOf on the default config: family
 *             first, the cheapest family with half of Jev's probability on
 *             it or cheaper, then its likeliest pair. Nothing here
 *             re-implements either: the bodies, the states and the
 *             decisions are the hooks' own.
 *
 * A case without a recorded previous answer is still asked and scored for
 * the shipped design, and left out of the paired comparison.
 *
 * The paired comparison is what says whether a difference is more than
 * noise: only the discordant cases (one design right, the other wrong)
 * carry information, and an exact two-sided binomial test on them (the
 * McNemar test, exact) says how likely a split that lopsided is when the
 * two designs are equally good. With 32 cases the earlier comparison's 6
 * against 1 came to p ≈ 0.13: a direction, not a result. Read individual
 * rows, not only the totals.
 *
 *   node scripts/eval/compare.mjs
 *   node scripts/eval/compare.mjs --dry-run          (print the shipped requests, call nothing)
 *   node scripts/eval/compare.mjs --only=id1,id2
 *   node scripts/eval/compare.mjs --cases=other.json --out=somewhere.json
 *
 * cases.json is an array of:
 *   {
 *     "id": "rename-var",               // unique; matched to the recorded run by it
 *     "class": "trivial",               // any label; accuracy is broken down by it
 *     "asking": "turn" | "subagent",    // who wrote the state
 *     "prompt": "...",                  // the turn's request, or the subagent's brief
 *     "description": "...",             // subagent only, optional
 *     "subagentType": "Explore",        // subagent only, optional
 *     "workflow": true,                 // subagent only, optional
 *     "parentRequest": "...",           // subagent only, optional: the developer's request
 *     "messages": [{ "role", "text", "toolUses" }],  // turn only, optional: the session before it
 *     "cwd": "/repo",                   // turn only, optional: what files_in_play is relative to
 *     "acceptable": ["sonnet_medium", "sonnet_high"]   // pair names
 *   }
 *
 * The recorded cases carry no session, so on them the comparison measures
 * the question, not the context fields; a case with `messages` measures
 * both, and has no previous answer to pair with.
 *
 * Reads TYPESAFE_API_KEY from the environment (TypeSafe direct, jev-latest)
 * and never prints it. Each run writes its results, every request exactly
 * as sent (the key is only ever in a header), to scripts/eval/results/
 * (git-ignored) unless --out says where, so any case can be rerun.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../../hooks/config.ts'
import { requestBodyOf } from '../../hooks/jev.ts'
import {
  excludedTiers,
  familySharesOf,
  ladderOf,
  offeredPairs,
  offeredTiers,
  pairSharesOf,
  PAIRS,
} from '../../hooks/policy.ts'
import { providerOf } from '../../hooks/provider.ts'
import { briefStateOf, turnStateOf } from '../../hooks/state.ts'
import { routedDecisionOf, routeOf } from '../../hooks/status.ts'

const here = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const flag = name => args.map(a => a.match(new RegExp(`^--${name}=(.*)$`))?.[1]).find(Boolean)
const dry = args.includes('--dry-run')
const only = flag('only')?.split(',')
const casesPath = flag('cases') ?? join(here, 'cases.json')
const recordedPath = flag('recorded') ?? join(here, 'ab-results.json')
const outPath =
  flag('out') ?? join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)

// The default config, not the person's settings: both designs as shipped.
const config = { ...DEFAULT_CONFIG }
const ladder = ladderOf(config)
const offered = offeredTiers(excludedTiers(undefined, ladder), config.fable, ladder)
const pairs = offeredPairs(offered, ladder)
const route = routeOf(config)

let cases = JSON.parse(readFileSync(casesPath, 'utf8'))
if (only) cases = cases.filter(c => only.includes(c.id))
for (const c of cases) {
  const bad = (c.acceptable ?? []).filter(p => !PAIRS.includes(p))
  if (!c.acceptable?.length || bad.length) {
    console.error(`case ${c.id}: acceptable must be a non-empty list of pair names${bad.length ? ` (bad: ${bad.join(', ')})` : ''}`)
    process.exit(1)
  }
  if (c.asking !== 'turn' && c.asking !== 'subagent') {
    console.error(`case ${c.id}: asking must be "turn" or "subagent"`)
    process.exit(1)
  }
}

/** The previous design's recorded answers, by case id. */
const recorded = (() => {
  try {
    const run = JSON.parse(readFileSync(recordedPath, 'utf8'))
    return new Map(run.results.map(r => [r.id, r.A]))
  } catch {
    console.error(`no recorded run at ${recordedPath}: every case is scored for the shipped design only`)
    return new Map()
  }
})()

/** The state exactly as the hooks build it. */
const stateOf = c =>
  c.asking === 'subagent'
    ? briefStateOf(
        {
          prompt: c.prompt,
          description: c.description,
          subagentType: c.subagentType,
          workflow: c.workflow,
        },
        c.parentRequest,
      )
    : turnStateOf({ request: c.prompt, messages: c.messages, cwd: c.cwd })

if (dry) {
  for (const c of cases) {
    console.log(`── ${c.id} (${c.asking})`)
    console.log(JSON.stringify(requestBodyOf(stateOf(c), offered, c.asking, config.fable, ladder)))
  }
  process.exit(0)
}

const provider = providerOf({
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  JEV_ROUTER_PROVIDER: 'typesafe',
  TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
})
if (!provider.ok) {
  console.error(`Provider error: ${provider.reason}`)
  process.exit(1)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * One POST. Returns the parsed response and the wall time; one retry on a
 * 429 or 5xx. A failure is returned as such, never read as an answer.
 */
async function post(body) {
  const payload = { ...body, model: provider.model }
  for (let attempt = 0; ; attempt++) {
    const started = Date.now()
    try {
      const r = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      })
      const text = await r.text()
      const ms = Date.now() - started
      if (!r.ok) {
        if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
          await sleep(1500)
          continue
        }
        return { ok: false, reason: `HTTP ${r.status}: ${text.slice(0, 200)}`, ms, payload }
      }
      const parsed = JSON.parse(text)
      if (!parsed?.answers) return { ok: false, reason: 'response carried no answers', ms, payload }
      return {
        ok: true,
        answers: parsed.answers,
        model: parsed.model,
        inputTokens: parsed.usage?.input_tokens ?? null,
        ms,
        payload,
      }
    } catch (error) {
      const ms = Date.now() - started
      if (attempt === 0) {
        await sleep(1500)
        continue
      }
      return { ok: false, reason: `request failed: ${error?.message ?? error}`, ms, payload }
    }
  }
}

const pairOfDecision = d => `${d.tier}_${d.effort}`

const results = []
for (const c of cases) {
  // Previous: the recorded answer, decided as the hooks decide it today.
  const was = recorded.get(c.id)
  const previous = was
    ? routedDecisionOf(
        was.raw ? { ok: true, answers: was.raw, ms: was.ms } : { ok: false, reason: was.error ?? 'no answer', ms: was.ms },
        offered,
        route,
      )
    : null

  // Shipped: asked live.
  const body = requestBodyOf(stateOf(c), offered, c.asking, config.fable, ladder)
  const got = await post(body)
  const shipped = routedDecisionOf(
    got.ok ? { ok: true, answers: got.answers, ms: got.ms } : { ok: false, reason: got.reason, ms: got.ms },
    offered,
    route,
  )
  const shares = got.ok ? pairSharesOf(got.answers?.route?.probabilities, pairs) : undefined

  results.push({
    id: c.id,
    class: c.class ?? '(none)',
    asking: c.asking,
    acceptable: c.acceptable,
    previous: previous
      ? {
          pair: pairOfDecision(previous),
          fallback: previous.fallback ?? null,
          floored: previous.floored ?? null,
          cumulative: previous.confidence,
          inputTokens: was.inputTokens ?? null,
        }
      : null,
    shipped: {
      pair: pairOfDecision(shipped),
      top: got.ok ? got.answers?.route?.choice ?? null : null,
      fallback: shipped.fallback ?? null,
      floored: shipped.floored ?? null,
      cumulative: shipped.confidence,
      shares: shares ?? null,
      families: shares ? familySharesOf(shares) : null,
      raw: got.ok ? got.answers : null,
      error: got.ok ? null : got.reason,
      ms: got.ms,
      inputTokens: got.ok ? got.inputTokens : null,
      model: got.ok ? got.model : null,
      request: got.payload,
    },
  })
  const r = results[results.length - 1]
  process.stderr.write(`${c.id}: previous ${r.previous?.pair ?? '-'}  shipped ${r.shipped.pair}\n`)
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), pairs, results }, null, 2))

// ── Report ──────────────────────────────────────────────────────────────

const rankOf = p => PAIRS.indexOf(p)
const familyOf = p => p.split('_')[0]

/** ok, over (above every acceptable pair), under (below every one), or gap. */
function verdictOf(pair, acceptable) {
  if (acceptable.includes(pair)) return 'ok'
  const r = rankOf(pair)
  const ranks = acceptable.map(rankOf)
  if (r > Math.max(...ranks)) return 'over'
  if (r < Math.min(...ranks)) return 'under'
  return 'gap'
}

const MARK = { ok: ' ', over: '+', under: '-', gap: '?' }
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
const pct = (n, d) => (d === 0 ? '  -  ' : `${((100 * n) / d).toFixed(0).padStart(3)}%`)

console.log('')
console.log('marks: + over-route, - under-route, ? inside the acceptable range but not in the set, F fallback')
console.log(`${pad('id', 22)} ${pad('class', 12)} ${pad('ask', 4)} ${pad('previous', 15)} ${pad('shipped', 15)} ${lpad('ms', 5)} ${lpad('tok', 5)}  acceptable`)
for (const r of results) {
  const cell = d => (d ? `${MARK[verdictOf(d.pair, r.acceptable)]}${d.fallback ? 'F' : ' '}${d.pair}` : '  -')
  console.log(
    `${pad(r.id.slice(0, 22), 22)} ${pad(r.class.slice(0, 12), 12)} ${pad(r.asking === 'turn' ? 'turn' : 'sub', 4)} ` +
      `${pad(cell(r.previous), 15)} ${pad(cell(r.shipped), 15)} ${lpad(r.shipped.ms, 5)} ${lpad(r.shipped.inputTokens ?? '-', 5)}  ${r.acceptable.join(',')}`,
  )
  if (r.shipped.families) {
    const families = Object.entries(r.shipped.families).map(([f, p]) => `${f} ${p.toFixed(2)}`).join(' · ')
    const top = pairs.filter(p => (r.shipped.shares[p] ?? 0) >= 0.05).map(p => `${p} ${r.shipped.shares[p].toFixed(2)}`).join(' · ')
    console.log(`${' '.repeat(42)}${families}   ${top}`)
  } else if (r.shipped.error) {
    console.log(`${' '.repeat(42)}error: ${r.shipped.error}`)
  }
}

console.log('')
console.log('accuracy (in acceptable set) / over / under / gap / fallback')
for (const [name, get] of [['previous', r => r.previous], ['shipped', r => r.shipped]]) {
  const scored = results.filter(get)
  const v = scored.map(r => verdictOf(get(r).pair, r.acceptable))
  const count = k => v.filter(x => x === k).length
  const fb = scored.filter(r => get(r).fallback).length
  console.log(
    `  ${pad(name, 9)} ${pct(count('ok'), v.length)} (${count('ok')}/${v.length})  over ${count('over')}  under ${count('under')}  gap ${count('gap')}  fallback ${fb}`,
  )
}

console.log('')
console.log('accuracy per class (cases with both designs)')
const paired = results.filter(r => r.previous)
for (const cls of [...new Set(paired.map(r => r.class))]) {
  const rs = paired.filter(r => r.class === cls)
  const ok = get => rs.filter(r => verdictOf(get(r).pair, r.acceptable) === 'ok').length
  console.log(`  ${pad(cls.slice(0, 14), 14)} ${lpad(rs.length, 3)}  previous ${pct(ok(r => r.previous), rs.length)}  shipped ${pct(ok(r => r.shipped), rs.length)}`)
}

/** Exact two-sided binomial p for `k` of `n` discordant cases at 1/2. */
function mcnemarExact(k, n) {
  if (n === 0) return 1
  const choose = (a, b) => {
    let c = 1
    for (let i = 1; i <= b; i++) c = (c * (a - b + i)) / i
    return c
  }
  const low = Math.min(k, n - k)
  let tail = 0
  for (let i = 0; i <= low; i++) tail += choose(n, i)
  return Math.min(1, (2 * tail) / 2 ** n)
}

const right = (d, r) => verdictOf(d.pair, r.acceptable) === 'ok'
const gained = paired.filter(r => right(r.shipped, r) && !right(r.previous, r))
const lost = paired.filter(r => !right(r.shipped, r) && right(r.previous, r))
console.log('')
console.log(
  `paired (${paired.length} cases): shipped right where previous was wrong ${gained.length}, ` +
    `the reverse ${lost.length}, exact McNemar p = ${mcnemarExact(gained.length, gained.length + lost.length).toFixed(3)}`,
)
if (gained.length) console.log(`  gained: ${gained.map(r => r.id).join(', ')}`)
if (lost.length) console.log(`  lost:   ${lost.map(r => r.id).join(', ')}`)
const sameModel = paired.filter(r => familyOf(r.previous.pair) === familyOf(r.shipped.pair)).length
console.log(`  same model ${pct(sameModel, paired.length)}`)

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const nums = xs => xs.filter(x => typeof x === 'number')
console.log('')
console.log(
  `input tokens mean  previous ${mean(nums(paired.map(r => r.previous.inputTokens))).toFixed(0)}` +
    `  shipped ${mean(nums(results.map(r => r.shipped.inputTokens))).toFixed(0)}` +
    `   latency mean ms shipped ${mean(results.map(r => r.shipped.ms)).toFixed(0)}`,
)
console.log(`results written to ${outPath}`)
