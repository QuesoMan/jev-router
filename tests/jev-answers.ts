/**
 * Jev's answers as the tests mock them: shaped the way the live API sends
 * them, probabilities included, so the router is tested on what it reads.
 *
 * Not a test file (the suite runs `tests/*.test.ts`), only the helpers the
 * test files share. Nothing here asserts an exact probability from a live
 * call; the distributions are made up to sit on either side of a bar.
 */

const TIER_ORDER = ["haiku", "sonnet", "opus", "fable"] as const;

/** Four decimals, as TypeSafe direct rounds them. */
const round = (p: number) => Math.round(p * 10000) / 10000;

/**
 * A distribution with `share` on `name` and the rest where Jev's doubt
 * usually sits: on Opus, the catch-all, for a tier below it; on Sonnet for
 * Opus; on Opus for Fable. A name that is not a tier gets all of it, so a
 * test can still say what Jev answers with an option nobody offered.
 */
export function sharesFor(name: string, share: number): Record<string, number> {
  const p = Math.min(Math.max(share, 0), 1);
  if (!(TIER_ORDER as readonly string[]).includes(name) || p >= 1) {
    return { [name]: 1 };
  }
  const doubt = name === "opus" ? "sonnet" : "opus";
  return { [name]: round(p), [doubt]: round(1 - p) };
}

/**
 * TypeSafe's Choice confidence for a distribution over `options` options:
 * (n × largest − 1) / (n − 1). How concentrated the answer is, which is
 * what the router no longer gates on; mocked so the answers look real.
 */
export function concentrationOf(
  shares: Readonly<Record<string, number>>,
  options = 3,
): number {
  const most = Math.max(0, ...Object.values(shares));
  return round(Math.max(0, (options * most - 1) / (options - 1)));
}

/** The option with the most probability, first in ladder order on a tie. */
export function topOf(shares: Readonly<Record<string, number>>): string {
  let top = "";
  let most = -1;
  for (const [name, p] of Object.entries(shares)) {
    if (p > most) {
      top = name;
      most = p;
    }
  }
  return top;
}

/** A tier answer as Jev sends it, from a distribution. */
export function tierAnswerOf(shares: Readonly<Record<string, number>>) {
  return {
    type: "choice",
    choice: topOf(shares),
    confidence: concentrationOf(shares),
    probabilities: { ...shares },
  };
}

/**
 * An effort answer as Jev sends it: the position, and probabilities keyed
 * by level number as a string, most of it on the level nearest the
 * position and the rest on its neighbour.
 */
export function effortAnswerOf(score: unknown, confidence = 0.8) {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { type: "score", score, confidence };
  }
  const low = Math.max(0, Math.min(4, Math.floor(score)));
  const high = Math.min(4, low + 1);
  const up = high === low ? 0 : score - low;
  const probabilities: Record<string, number> = {
    "0": 0,
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
  };
  probabilities[String(low)] = round(1 - up);
  if (high !== low) probabilities[String(high)] = round(up);
  return { type: "score", score, confidence, probabilities };
}
