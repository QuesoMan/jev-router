import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  BAND_SETTING,
  CONFIG_ENV,
  CONFIG_ENV_KEYS,
  configOf,
  CONTEXT_MODES,
  DEFAULT_CONFIG,
  FABLE_MODES,
} from "../hooks/config.ts";
import { BAND_NAMES, EFFORTS, TIERS } from "../hooks/policy.ts";

const noEnv = {};

/**
 * The ladder's settings at their defaults, and the context setting's, for
 * comparing whole configs.
 */
const LADDER_DEFAULTS = {
  defaultModel: "opus",
  defaultEffort: "high",
  haikuEffort: "medium-high",
  sonnetEffort: "medium-max",
  opusEffort: "medium-max",
  fableEffort: "medium-max",
  context: "full",
};

describe("defaults", () => {
  test("the money-saving policy is what a new user gets", () => {
    assert.deepEqual(DEFAULT_CONFIG, {
      fable: "never",
      fableConfidence: 0.75,
      minConfidence: 0.5,
      routeSubagents: true,
      ...LADDER_DEFAULTS,
    });
  });

  test("nothing set anywhere is the defaults", () => {
    assert.deepEqual(configOf(undefined, noEnv), DEFAULT_CONFIG);
    assert.deepEqual(configOf({}, noEnv), DEFAULT_CONFIG);
  });

  test("the result is a fresh object, so a caller cannot edit the defaults", () => {
    const config = configOf(undefined, noEnv);
    config.fable = "open";
    assert.equal(DEFAULT_CONFIG.fable, "never");
  });

  test("the env names are the eleven documented ones", () => {
    assert.deepEqual(
      [...CONFIG_ENV_KEYS].sort(),
      [
        "JEV_ROUTER_CONTEXT",
        "JEV_ROUTER_DEFAULT_EFFORT",
        "JEV_ROUTER_DEFAULT_MODEL",
        "JEV_ROUTER_FABLE",
        "JEV_ROUTER_FABLE_CONFIDENCE",
        "JEV_ROUTER_FABLE_EFFORT",
        "JEV_ROUTER_HAIKU_EFFORT",
        "JEV_ROUTER_MIN_CONFIDENCE",
        "JEV_ROUTER_OPUS_EFFORT",
        "JEV_ROUTER_SONNET_EFFORT",
        "JEV_ROUTER_SUBAGENTS",
      ],
    );
  });

  test("every family's band has a setting of its own", () => {
    assert.deepEqual(Object.keys(BAND_SETTING).sort(), [...TIERS].sort());
    for (const tier of TIERS) {
      assert.equal(BAND_SETTING[tier], `${tier}Effort`, tier);
    }
  });
});

describe("precedence: env, then option, then default", () => {
  test("an option is taken over the default", () => {
    assert.deepEqual(
      configOf(
        {
          fable: "hardest",
          fableConfidence: 0.9,
          minConfidence: 0.3,
          routeSubagents: false,
        },
        noEnv,
      ),
      {
        fable: "hardest",
        fableConfidence: 0.9,
        minConfidence: 0.3,
        routeSubagents: false,
        ...LADDER_DEFAULTS,
      },
    );
  });

  test("an env var is taken over the option, field by field", () => {
    const options = {
      fable: "hardest",
      fableConfidence: 0.9,
      minConfidence: 0.3,
      routeSubagents: false,
    };
    assert.equal(configOf(options, { JEV_ROUTER_FABLE: "open" }).fable, "open");
    assert.equal(
      configOf(options, { JEV_ROUTER_FABLE_CONFIDENCE: "0.6" }).fableConfidence,
      0.6,
    );
    assert.equal(
      configOf(options, { JEV_ROUTER_MIN_CONFIDENCE: "0.2" }).minConfidence,
      0.2,
    );
    assert.equal(
      configOf(options, { JEV_ROUTER_SUBAGENTS: "1" }).routeSubagents,
      true,
    );
  });

  test("one env var moves only its own field", () => {
    const config = configOf(
      { fable: "hardest", minConfidence: 0.3 },
      { JEV_ROUTER_FABLE: "never" },
    );
    assert.equal(config.fable, "never");
    assert.equal(config.minConfidence, 0.3, "the option still stands");
    assert.equal(config.fableConfidence, DEFAULT_CONFIG.fableConfidence);
    assert.equal(config.routeSubagents, DEFAULT_CONFIG.routeSubagents);
  });

  test("an env var beats the default with no option at all", () => {
    assert.equal(configOf(undefined, { JEV_ROUTER_FABLE: "open" }).fable, "open");
  });

  test("an unset or empty env var is not a value", () => {
    assert.equal(
      configOf({ fable: "hardest" }, { JEV_ROUTER_FABLE: undefined }).fable,
      "hardest",
    );
    assert.equal(
      configOf({ fable: "hardest" }, { JEV_ROUTER_FABLE: "" }).fable,
      "hardest",
    );
    assert.equal(
      configOf({ minConfidence: 0.3 }, { JEV_ROUTER_MIN_CONFIDENCE: "  " })
        .minConfidence,
      0.3,
    );
  });
});

describe("invalid values fall through rather than throw", () => {
  test("a bad env var falls through to the option", () => {
    const options = {
      fable: "hardest",
      fableConfidence: 0.9,
      minConfidence: 0.3,
      routeSubagents: false,
    };
    const config = configOf(options, {
      JEV_ROUTER_FABLE: "always",
      JEV_ROUTER_FABLE_CONFIDENCE: "high",
      JEV_ROUTER_MIN_CONFIDENCE: "-1",
      JEV_ROUTER_SUBAGENTS: "maybe",
    });
    assert.deepEqual(config, { ...options, ...LADDER_DEFAULTS });
  });

  test("a bad env var and a bad option fall through to the default", () => {
    const config = configOf(
      {
        fable: "sometimes",
        fableConfidence: "lots",
        minConfidence: 250,
        routeSubagents: "perhaps",
      },
      {
        JEV_ROUTER_FABLE: "1",
        JEV_ROUTER_FABLE_CONFIDENCE: "0",
        JEV_ROUTER_MIN_CONFIDENCE: "150",
        JEV_ROUTER_SUBAGENTS: "2",
      },
    );
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  test("an option of the wrong type is skipped", () => {
    const config = configOf(
      {
        fable: 1,
        fableConfidence: true,
        minConfidence: ["0.2"],
        routeSubagents: 1,
      },
      noEnv,
    );
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  test("NaN and infinities are not confidences", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      assert.equal(
        configOf({ minConfidence: bad }, noEnv).minConfidence,
        DEFAULT_CONFIG.minConfidence,
        String(bad),
      );
      assert.equal(
        configOf({ fableConfidence: bad }, noEnv).fableConfidence,
        DEFAULT_CONFIG.fableConfidence,
        String(bad),
      );
    }
    assert.equal(
      configOf(undefined, { JEV_ROUTER_FABLE_CONFIDENCE: "Infinity" })
        .fableConfidence,
      DEFAULT_CONFIG.fableConfidence,
    );
  });
});

describe("the Fable setting", () => {
  test("every mode is read, whatever its case or padding", () => {
    for (const mode of FABLE_MODES) {
      assert.equal(configOf({ fable: mode }, noEnv).fable, mode);
      assert.equal(
        configOf(undefined, { JEV_ROUTER_FABLE: ` ${mode.toUpperCase()} ` }).fable,
        mode,
      );
    }
    assert.equal(configOf({ fable: "Hardest" }, noEnv).fable, "hardest");
    assert.equal(configOf(undefined, { JEV_ROUTER_FABLE: "OpEn" }).fable, "open");
  });

  test("only the three modes exist", () => {
    assert.deepEqual([...FABLE_MODES], ["never", "hardest", "open"]);
    for (const bad of ["yes", "on", "true", "max", "fable"]) {
      assert.equal(configOf(undefined, { JEV_ROUTER_FABLE: bad }).fable, "never", bad);
    }
  });
});

describe("confidences", () => {
  test("a ratio is taken as given", () => {
    const config = configOf(
      undefined,
      { JEV_ROUTER_FABLE_CONFIDENCE: "0.8", JEV_ROUTER_MIN_CONFIDENCE: "0.6" },
    );
    assert.equal(config.fableConfidence, 0.8);
    assert.equal(config.minConfidence, 0.6);
  });

  test("a value above 1 is read as a percentage, from env or option", () => {
    assert.equal(
      configOf(undefined, { JEV_ROUTER_FABLE_CONFIDENCE: "90" }).fableConfidence,
      0.9,
    );
    assert.equal(
      configOf(undefined, { JEV_ROUTER_MIN_CONFIDENCE: "70" }).minConfidence,
      0.7,
    );
    assert.equal(configOf({ fableConfidence: 85 }, noEnv).fableConfidence, 0.85);
    assert.equal(configOf({ minConfidence: 40 }, noEnv).minConfidence, 0.4);
    assert.equal(configOf({ minConfidence: "65" }, noEnv).minConfidence, 0.65);
  });

  test("1 and 100 both mean certainty", () => {
    assert.equal(configOf({ fableConfidence: 1 }, noEnv).fableConfidence, 1);
    assert.equal(configOf({ fableConfidence: 100 }, noEnv).fableConfidence, 1);
    assert.equal(configOf({ minConfidence: 100 }, noEnv).minConfidence, 1);
  });

  test("above 100 percent is refused", () => {
    assert.equal(
      configOf({ fableConfidence: 101 }, noEnv).fableConfidence,
      DEFAULT_CONFIG.fableConfidence,
    );
    assert.equal(
      configOf({ minConfidence: 150 }, noEnv).minConfidence,
      DEFAULT_CONFIG.minConfidence,
    );
  });

  test("0 turns the floor off", () => {
    assert.equal(configOf({ minConfidence: 0 }, noEnv).minConfidence, 0);
    assert.equal(
      configOf({ minConfidence: 0.5 }, { JEV_ROUTER_MIN_CONFIDENCE: "0" })
        .minConfidence,
      0,
    );
  });

  test("0 is not a Fable bar, since it would let every shaky pick through", () => {
    assert.equal(
      configOf({ fableConfidence: 0.9 }, { JEV_ROUTER_FABLE_CONFIDENCE: "0" })
        .fableConfidence,
      0.9,
    );
    assert.equal(
      configOf({ fableConfidence: 0 }, noEnv).fableConfidence,
      DEFAULT_CONFIG.fableConfidence,
    );
  });
});

describe("routing subagents", () => {
  test("on by default", () => {
    assert.equal(configOf(undefined, noEnv).routeSubagents, true);
  });

  test("the flag is read the ways people actually set flags", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on", " On "]) {
      assert.equal(
        configOf({ routeSubagents: false }, { JEV_ROUTER_SUBAGENTS: on })
          .routeSubagents,
        true,
        on,
      );
    }
    for (const off of ["0", "false", "False", "no", "off", " OFF "]) {
      assert.equal(
        configOf({ routeSubagents: true }, { JEV_ROUTER_SUBAGENTS: off })
          .routeSubagents,
        false,
        off,
      );
    }
  });

  test("an option may be a boolean or a flag string", () => {
    assert.equal(configOf({ routeSubagents: false }, noEnv).routeSubagents, false);
    assert.equal(configOf({ routeSubagents: "off" }, noEnv).routeSubagents, false);
  });
});

describe("the context setting", () => {
  test("full unless set", () => {
    assert.equal(configOf(undefined, noEnv).context, "full");
    assert.deepEqual([...CONTEXT_MODES], ["full", "request"]);
  });

  test("read from env or option, whatever its case, env first", () => {
    assert.equal(configOf({ context: "request" }, noEnv).context, "request");
    assert.equal(configOf({ context: " Request " }, noEnv).context, "request");
    assert.equal(
      configOf(undefined, { JEV_ROUTER_CONTEXT: "REQUEST" }).context,
      "request",
    );
    assert.equal(
      configOf({ context: "request" }, { JEV_ROUTER_CONTEXT: "full" }).context,
      "full",
    );
  });

  test("an env value that is not a mode reads as request, not as the option", () => {
    for (const typo of ["request-only", "minimal", "none", " off "]) {
      for (const option of [undefined, "full", "request"]) {
        assert.equal(
          configOf({ context: option }, { JEV_ROUTER_CONTEXT: typo }).context,
          "request",
          `${typo} over ${option}`,
        );
      }
    }
  });

  test("a blank env var is unset; an unreadable option falls through to the default", () => {
    assert.equal(
      configOf({ context: "request" }, { JEV_ROUTER_CONTEXT: "" }).context,
      "request",
    );
    assert.equal(
      configOf(undefined, { JEV_ROUTER_CONTEXT: "  " }).context,
      "full",
    );
    for (const bad of ["minimal", "", 1, true, null, ["request"]]) {
      assert.equal(configOf({ context: bad }, noEnv).context, "full", String(bad));
    }
  });

  test("it moves only its own field", () => {
    const config = configOf(undefined, { JEV_ROUTER_CONTEXT: "request" });
    assert.deepEqual(config, { ...DEFAULT_CONFIG, context: "request" });
  });
});

describe("the default model", () => {
  test("Opus unless set", () => {
    assert.equal(configOf(undefined, noEnv).defaultModel, "opus");
  });

  test("every family is read, from env or option, whatever its case", () => {
    for (const tier of TIERS) {
      assert.equal(configOf({ defaultModel: tier }, noEnv).defaultModel, tier);
      assert.equal(
        configOf(undefined, { JEV_ROUTER_DEFAULT_MODEL: ` ${tier.toUpperCase()} ` })
          .defaultModel,
        tier,
      );
    }
  });

  test("env beats option beats default", () => {
    assert.equal(
      configOf({ defaultModel: "sonnet" }, { JEV_ROUTER_DEFAULT_MODEL: "haiku" })
        .defaultModel,
      "haiku",
    );
    assert.equal(configOf({ defaultModel: "sonnet" }, noEnv).defaultModel, "sonnet");
  });

  test("an unknown name, an old rung name or the wrong type falls through", () => {
    for (const bad of ["opus-high", "sonnet-medium", "gpt", "", "  "]) {
      assert.equal(
        configOf({ defaultModel: "sonnet" }, { JEV_ROUTER_DEFAULT_MODEL: bad })
          .defaultModel,
        "sonnet",
        bad,
      );
      assert.equal(configOf({ defaultModel: bad }, noEnv).defaultModel, "opus", bad);
    }
    assert.equal(configOf({ defaultModel: 3 }, noEnv).defaultModel, "opus");
  });

  test("Fable is read as asked: whether it may be the default is the ladder's call", () => {
    assert.equal(
      configOf({ fable: "never", defaultModel: "fable" }, noEnv).defaultModel,
      "fable",
    );
  });
});

describe("the default effort", () => {
  test("high unless set", () => {
    assert.equal(configOf(undefined, noEnv).defaultEffort, "high");
  });

  test("every level is read, from env or option, whatever its case", () => {
    for (const effort of EFFORTS) {
      assert.equal(configOf({ defaultEffort: effort }, noEnv).defaultEffort, effort);
      assert.equal(
        configOf(undefined, { JEV_ROUTER_DEFAULT_EFFORT: ` ${effort.toUpperCase()} ` })
          .defaultEffort,
        effort,
      );
    }
  });

  test("env beats option beats default; junk falls through", () => {
    assert.equal(
      configOf({ defaultEffort: "medium" }, { JEV_ROUTER_DEFAULT_EFFORT: "max" })
        .defaultEffort,
      "max",
    );
    assert.equal(
      configOf({ defaultEffort: "medium" }, { JEV_ROUTER_DEFAULT_EFFORT: "extreme" })
        .defaultEffort,
      "medium",
    );
    assert.equal(
      configOf({ defaultEffort: "medium-high" }, noEnv).defaultEffort,
      "high",
      "a band is not a level",
    );
    assert.equal(configOf({ defaultEffort: 2 }, noEnv).defaultEffort, "high");
  });

  test("a level outside the default model's band is kept as asked; the ladder clamps it", () => {
    assert.equal(
      configOf({ defaultEffort: "low", opusEffort: "high-max" }, noEnv)
        .defaultEffort,
      "low",
    );
  });
});

describe("effort bands", () => {
  const bandFrom = (raw: unknown, fallback = "medium-max") =>
    configOf({ sonnetEffort: fallback }, { JEV_ROUTER_SONNET_EFFORT: raw as string })
      .sonnetEffort;

  test("the defaults are Haiku medium to high and the rest medium to max", () => {
    const config = configOf(undefined, noEnv);
    assert.equal(config.haikuEffort, "medium-high");
    assert.equal(config.sonnetEffort, "medium-max");
    assert.equal(config.opusEffort, "medium-max");
    assert.equal(config.fableEffort, "medium-max");
  });

  test("a range is read as min-max", () => {
    assert.equal(bandFrom("high-max"), "high-max");
    assert.equal(bandFrom("low-medium"), "low-medium");
  });

  test("a single level is a band of that level alone", () => {
    assert.equal(bandFrom("high"), "high");
    assert.equal(bandFrom("high-high"), "high", "written the one way");
  });

  test("case and padding do not matter in the env", () => {
    assert.equal(bandFrom("  HIGH - Max "), "high-max");
    assert.equal(bandFrom("XHigh"), "xhigh");
  });

  test("the en dash /jev prints and .. are read as the separator too", () => {
    assert.equal(bandFrom("medium–xhigh"), "medium-xhigh");
    assert.equal(bandFrom("medium..xhigh"), "medium-xhigh");
  });

  test("an inverted band falls through rather than being turned around", () => {
    assert.equal(bandFrom("max-medium", "high-max"), "high-max");
    assert.equal(
      configOf({ opusEffort: "xhigh-medium" }, noEnv).opusEffort,
      "medium-max",
      "an inverted option falls to the default",
    );
  });

  test("junk falls through to the option, then the default", () => {
    for (const bad of ["", "  ", "medium-", "-high", "low-medium-high", "huge", "1-3", "medium high"]) {
      assert.equal(bandFrom(bad, "high-xhigh"), "high-xhigh", JSON.stringify(bad));
    }
    assert.equal(
      configOf({ haikuEffort: "lots" }, { JEV_ROUTER_HAIKU_EFFORT: "more" })
        .haikuEffort,
      "medium-high",
    );
    assert.equal(configOf({ opusEffort: 4 }, noEnv).opusEffort, "medium-max");
  });

  test("each band reads its own env var and option, and nothing else", () => {
    const config = configOf(
      { haikuEffort: "low-high", fableEffort: "max" },
      {
        JEV_ROUTER_SONNET_EFFORT: "medium",
        JEV_ROUTER_OPUS_EFFORT: "high",
        JEV_ROUTER_FABLE_EFFORT: "xhigh-max",
      },
    );
    assert.equal(config.haikuEffort, "low-high");
    assert.equal(config.sonnetEffort, "medium");
    assert.equal(config.opusEffort, "high");
    assert.equal(config.fableEffort, "xhigh-max", "the env beats the option");
  });

  test("an option is read the same way as the env", () => {
    assert.equal(configOf({ opusEffort: "High-High" }, noEnv).opusEffort, "high");
  });

  test("every band name reads back as itself", () => {
    for (const name of BAND_NAMES) {
      assert.equal(bandFrom(name, "max"), name, name);
    }
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
  ) as {
    version: string;
    userConfig: Record<
      string,
      { type: string; default: unknown; options?: string[]; title?: string; description?: string }
    >;
  };

  test("declares exactly the fields configOf reads, under the same keys", () => {
    assert.deepEqual(
      Object.keys(manifest.userConfig).sort(),
      Object.keys(CONFIG_ENV).sort(),
    );
  });

  test("its defaults are DEFAULT_CONFIG, so /config and the code agree", () => {
    for (const [key, field] of Object.entries(manifest.userConfig)) {
      assert.equal(
        field.default,
        DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG],
        key,
      );
    }
    assert.deepEqual(
      configOf(
        Object.fromEntries(
          Object.entries(manifest.userConfig).map(([k, f]) => [k, f.default]),
        ),
        noEnv,
      ),
      DEFAULT_CONFIG,
    );
  });

  test("Fable is a picker over the three modes, defaulting to never", () => {
    const fable = manifest.userConfig.fable;
    assert.equal(fable?.type, "string");
    assert.deepEqual(fable?.options, [...FABLE_MODES]);
    assert.equal(fable?.default, "never");
  });

  test("the default model is a picker over the families, defaulting to opus", () => {
    const field = manifest.userConfig.defaultModel;
    assert.equal(field?.type, "string");
    assert.deepEqual(field?.options, [...TIERS]);
    assert.equal(field?.default, "opus");
  });

  test("the default effort is a picker over the levels, defaulting to high", () => {
    const field = manifest.userConfig.defaultEffort;
    assert.equal(field?.type, "string");
    assert.deepEqual(field?.options, [...EFFORTS]);
    assert.equal(field?.default, "high");
  });

  test("each band is a picker over every valid band, defaulting to the default band", () => {
    assert.equal(BAND_NAMES.length, 15);
    for (const tier of TIERS) {
      const key = BAND_SETTING[tier];
      const field = manifest.userConfig[key];
      assert.equal(field?.type, "string", key);
      assert.deepEqual(field?.options, [...BAND_NAMES], key);
      assert.ok(field?.options?.includes(field.default as string), key);
      assert.equal(field?.default, DEFAULT_CONFIG[key], key);
    }
  });

  test("the version is 0.4.1", () => {
    assert.equal(manifest.version, "0.4.1");
  });

  test("the context setting is a picker over its modes, defaulting to full", () => {
    const field = manifest.userConfig.context;
    assert.equal(field?.type, "string");
    assert.deepEqual(field?.options, [...CONTEXT_MODES]);
    assert.equal(field?.default, DEFAULT_CONFIG.context);
    assert.match(field?.description ?? "", /JEV_ROUTER_CONTEXT/);
  });

  test("each field is typed the way configOf reads it", () => {
    assert.equal(manifest.userConfig.fableConfidence?.type, "number");
    assert.equal(manifest.userConfig.minConfidence?.type, "number");
    assert.equal(manifest.userConfig.routeSubagents?.type, "boolean");
    for (const [key, field] of Object.entries(manifest.userConfig)) {
      assert.ok(field.title, `${key} has a title`);
      assert.ok(field.description, `${key} has a description`);
    }
  });
});
