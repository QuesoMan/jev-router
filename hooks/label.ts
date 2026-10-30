/**
 * The footer label, and the two small words every surface names a decision
 * by. `SessionMode` draws the strings it is handed, so this file's job is to
 * turn a decision into one of them; `status.ts` borrows the same words so the
 * footer, the route line and `/jev` can never spell a pairing two ways.
 */

import { familyOf, type Decision } from "./policy.ts";

/**
 * Below this, the pick is marked so a bad route is visible rather than
 * silent. Read against a decision's `confidence`, the share of Jev's
 * probability, its pairs added up per family, that says the family it runs
 * on (or a cheaper one) is enough;
 * at the default floor of 0.5 a fresh pick is never under it, so the mark
 * shows on a lower floor, a choice-only answer, or a decision kept from
 * before, whose number is the answer's old concentration score.
 */
export const LOW_CONFIDENCE = 0.5;

/**
 * What a decision runs on, as a person reads it: `opus·high`, `sonnet·medium`,
 * `haiku·medium`, `fable·max`.
 *
 * The family comes from the tier and the effort from the decision, which
 * is always inside the family's range: a held turn keeps the previous model
 * but thinks as hard as Jev asked (clamped there), and the label says what
 * actually runs.
 */
export function rungOf(decision: Decision): string {
  return `${familyOf(decision.tier)}·${decision.effort}`;
}

/**
 * The marks saying the turn did not simply go where Jev pointed:
 * `held:<tier>` (stickiness kept the model), `floored:<tier>` (too little
 * of Jev's probability said the family of its top pair, the one named, was
 * enough, so the turn went up to the cheapest family enough of it backs), `capped:<tier>`
 * (a Fable pick the person's setting would not take ran on Opus at the top
 * of its band, max unless they narrowed it) and `fallback` (Jev could not
 * be asked or did not answer, and the default ran: Opus at high effort,
 * unless the person set another default).
 *
 * Each of these says why the turn is not on Jev's top choice, so a label
 * that carries one skips the `?`: the mark is the more useful of the two. A capped pick
 * can be confident and still capped (under "never"), and the mark says so
 * better than a number would.
 */
export function marksOf(decision: Decision): string[] {
  const marks: string[] = [];
  if (decision.held !== undefined) marks.push(`held:${decision.held}`);
  if (decision.floored !== undefined) marks.push(`floored:${decision.floored}`);
  if (decision.capped !== undefined) marks.push(`capped:${decision.capped}`);
  if (decision.fallback !== undefined) marks.push("fallback");
  return marks;
}

/** The `?` for a shaky pick nothing else already explains. */
export function doubtOf(decision: Decision): string {
  return marksOf(decision).length === 0 && decision.confidence < LOW_CONFIDENCE
    ? "?"
    : "";
}

/**
 * The label for the footer, or null to add nothing.
 *
 * Null rather than a placeholder before the first turn: a footer that says
 * nothing reads better than one that says the router has not run yet.
 */
export function labelOf(
  decision: Decision | null,
  enabled: boolean,
): string | null {
  if (!enabled) return "jev off";
  if (!decision) return null;

  const marks = marksOf(decision);
  return (
    `jev → ${rungOf(decision)}${doubtOf(decision)}` +
    `${marks.map((m) => ` · ${m}`).join("")}`
  );
}

/** The modes array `SessionMode` should draw, with our label on the end. */
export function withLabel(
  modes: readonly string[],
  label: string | null,
): readonly string[] {
  if (label === null) return modes;
  if (modes.includes(label)) return modes;
  return [...modes, label];
}
