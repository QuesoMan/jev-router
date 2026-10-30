/**
 * What jev-router keeps in `$.state`: the few things a hot reload must not
 * lose. A change to any `userConfig` field (the Fable picker among them)
 * reloads the module and runs `register` again from nothing, so whatever
 * lived in its closure is gone: `/jev off` would quietly turn itself back
 * on, and a teammate routed to Opus an hour ago would be asked about again
 * on the one-line message that woke it.
 *
 * Plain JSON, as `$.state` takes. The hooks module reads these back with a
 * check of its own, so a value an older copy wrote is never trusted blind.
 */

/**
 * The `/jev` switches: on or off, the announcement, the sticky bar, and
 * what the main loop last ran on.
 */
export type JevRouterSwitches = {
  enabled: boolean;
  announce: boolean;
  /**
   * The share of Jev's probability that must say the cheaper model is
   * enough before a switch down, or null when stickiness is off.
   */
  sticky: number | null;
  /**
   * The decision the last routed main-loop turn ran on, which stickiness
   * holds to and a continuation carries on with; null before the first.
   * Absent where an older copy wrote the switches. A decision carries the
   * distribution it was picked from (`probabilities`) when Jev sent one:
   * on model·effort pairs (`sonnet_high`) for one decided from the `route`
   * question, on families (`sonnet`) for one 0.3 kept. One older still has
   * none, and its `confidence` is then the answer's own, kept for the label
   * only. Every shape is read back by `revivedDecision`.
   */
  running?: Readonly<Record<string, unknown>> | null;
};

/**
 * One agent's routing, by its id: the decision its steps run on and the row
 * its usage is added to, or why it was left alone.
 */
export type JevRouterAgent =
  | {
      decision: Readonly<Record<string, unknown>>;
      attempt: Readonly<Record<string, unknown>>;
      /** The prompt its spawn asked Jev about, until its first turn starts. */
      prompt?: string;
    }
  | { skipped: string };

declare module "claude-code" {
  interface PluginState {
    "jev-router": {
      switches: JevRouterSwitches;
      agents: StateFamily<JevRouterAgent>;
    };
  }
}
