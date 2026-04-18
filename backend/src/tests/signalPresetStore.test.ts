import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBotDefinition } from "../bots/registry.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function defaultThresholds() {
  const botDef = getBotDefinition();
  const defaults = botDef.defaults;
  return {
    candidate: { ...defaults.candidate },
    derivatives: { ...defaults.derivatives },
    exhaustion: { ...defaults.exhaustion },
    microstructure: { ...defaults.microstructure },
    observe: {
      totalScoreMin: defaults.observe.totalScoreMin,
    },
  };
}

async function loadStore(seed?: unknown) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-preset-store-"));
  tempDirs.push(tempDir);
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  if (seed !== undefined) {
    fs.writeFileSync(
      path.join(tempDir, "data", "short-signal-presets.json"),
      JSON.stringify(seed, null, 2),
      "utf8",
    );
  }
  process.chdir(tempDir);
  vi.resetModules();
  return await import("../runtime/signalPresetStore.js");
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("signal preset store built-ins", () => {
  it("seeds default and pump-fade built-ins in a clean state", async () => {
    const module = await loadStore();
    const presets = module.signalPresetStore.getAll();
    const ids = presets.map((preset) => preset.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        module.DEFAULT_SIGNAL_PRESET_ID,
        module.PUMP_FADE_BALANCED_PRESET_ID,
        module.PUMP_FADE_STRICT_PRESET_ID,
        module.PUMP_FADE_AGGRESSIVE_PRESET_ID,
        module.PUMP_FADE_HIGH_FREQUENCY_PRESET_ID,
      ]),
    );
    expect(presets.length).toBeGreaterThanOrEqual(5);
  });

  it("seeds exact built-in candidate values and inherits non-candidate groups from defaults", async () => {
    const module = await loadStore();
    const presets = module.signalPresetStore.getAll();
    const defaults = defaultThresholds();
    const balanced = presets.find((preset) => preset.id === module.PUMP_FADE_BALANCED_PRESET_ID);
    const strict = presets.find((preset) => preset.id === module.PUMP_FADE_STRICT_PRESET_ID);
    const aggressive = presets.find((preset) => preset.id === module.PUMP_FADE_AGGRESSIVE_PRESET_ID);
    const highFrequency = presets.find((preset) => preset.id === module.PUMP_FADE_HIGH_FREQUENCY_PRESET_ID);

    expect(balanced?.name).toBe("Pump Fade Balanced");
    expect(balanced?.thresholds.candidate).toEqual({
      minPriceMove1mPct: 0.9,
      minPriceMove3mPct: 2.0,
      minPriceMove5mPct: 3.8,
      minPriceMove15mPct: 6.0,
      minVolumeBurstRatio: 2.2,
      minTurnoverBurstRatio: 2.2,
      maxUniverseRank: 3,
      minTurnover24hUsd: 35_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 5_000_000,
      minTrades1m: 50,
      maxSpreadBps: 20,
      minDistanceFromLow24hPct: 8,
      minNearDepthUsd: 30_000,
      candidateScoreMin: 1.4,
    });
    expect(balanced?.thresholds.derivatives).toEqual(defaults.derivatives);
    expect(balanced?.thresholds.exhaustion).toEqual(defaults.exhaustion);
    expect(balanced?.thresholds.microstructure).toEqual(defaults.microstructure);
    expect(balanced?.thresholds.observe).toEqual(defaults.observe);

    expect(strict?.name).toBe("Pump Fade Strict");
    expect(strict?.thresholds.candidate).toEqual({
      minPriceMove1mPct: 1.0,
      minPriceMove3mPct: 2.2,
      minPriceMove5mPct: 4.2,
      minPriceMove15mPct: 6.5,
      minVolumeBurstRatio: 2.4,
      minTurnoverBurstRatio: 2.4,
      maxUniverseRank: 3,
      minTurnover24hUsd: 45_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 6_000_000,
      minTrades1m: 60,
      maxSpreadBps: 18,
      minDistanceFromLow24hPct: 9,
      minNearDepthUsd: 40_000,
      candidateScoreMin: 1.48,
    });
    expect(strict?.thresholds.derivatives).toEqual(defaults.derivatives);
    expect(strict?.thresholds.exhaustion).toEqual(defaults.exhaustion);
    expect(strict?.thresholds.microstructure).toEqual(defaults.microstructure);
    expect(strict?.thresholds.observe).toEqual(defaults.observe);

    expect(aggressive?.name).toBe("Pump Fade Aggressive");
    expect(aggressive?.thresholds.candidate).toEqual({
      minPriceMove1mPct: 0.75,
      minPriceMove3mPct: 1.6,
      minPriceMove5mPct: 2.8,
      minPriceMove15mPct: 4.8,
      minVolumeBurstRatio: 1.9,
      minTurnoverBurstRatio: 1.9,
      maxUniverseRank: 5,
      minTurnover24hUsd: 20_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 3_500_000,
      minTrades1m: 35,
      maxSpreadBps: 24,
      minDistanceFromLow24hPct: 6,
      minNearDepthUsd: 20_000,
      candidateScoreMin: 1.18,
    });
    expect(aggressive?.thresholds.derivatives).toEqual(defaults.derivatives);
    expect(aggressive?.thresholds.exhaustion).toEqual(defaults.exhaustion);
    expect(aggressive?.thresholds.microstructure).toEqual(defaults.microstructure);
    expect(aggressive?.thresholds.observe).toEqual(defaults.observe);

    expect(highFrequency?.name).toBe("Pump Fade High Frequency");
    expect(highFrequency?.thresholds.candidate).toEqual({
      minPriceMove1mPct: 0.65,
      minPriceMove3mPct: 1.35,
      minPriceMove5mPct: 2.4,
      minPriceMove15mPct: 4.2,
      minVolumeBurstRatio: 1.75,
      minTurnoverBurstRatio: 1.75,
      maxUniverseRank: 6,
      minTurnover24hUsd: 15_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 2_500_000,
      minTrades1m: 28,
      maxSpreadBps: 26,
      minDistanceFromLow24hPct: 5,
      minNearDepthUsd: 16_000,
      candidateScoreMin: 1.05,
    });
    expect(highFrequency?.thresholds.derivatives).toEqual(defaults.derivatives);
    expect(highFrequency?.thresholds.exhaustion).toEqual(defaults.exhaustion);
    expect(highFrequency?.thresholds.microstructure).toEqual(defaults.microstructure);
    expect(highFrequency?.thresholds.observe).toEqual(defaults.observe);
  });

  it("preserves existing custom presets when built-ins are ensured", async () => {
    const thresholds = defaultThresholds();
    const module = await loadStore({
      presets: [
        {
          id: "custom_liquid_watch",
          name: "Custom Liquid Watch",
          thresholds: {
            ...thresholds,
            candidate: {
              ...thresholds.candidate,
              candidateScoreMin: 1.33,
            },
          },
          createdAt: 1_777_000_000_000,
          updatedAt: 1_777_000_000_000,
        },
      ],
    });

    const presets = module.signalPresetStore.getAll();
    const custom = presets.find((preset) => preset.id === "custom_liquid_watch");

    expect(custom?.name).toBe("Custom Liquid Watch");
    expect(custom?.thresholds.candidate.candidateScoreMin).toBe(1.33);
    expect(presets.map((preset) => preset.id)).toEqual(
      expect.arrayContaining([
        "custom_liquid_watch",
        module.DEFAULT_SIGNAL_PRESET_ID,
        module.PUMP_FADE_BALANCED_PRESET_ID,
        module.PUMP_FADE_STRICT_PRESET_ID,
        module.PUMP_FADE_AGGRESSIVE_PRESET_ID,
        module.PUMP_FADE_HIGH_FREQUENCY_PRESET_ID,
      ]),
    );
  });

  it("keeps existing built-ins unchanged while adding the new aggressive presets", async () => {
    const module = await loadStore();
    const presets = module.signalPresetStore.getAll();
    const balanced = presets.find((preset) => preset.id === module.PUMP_FADE_BALANCED_PRESET_ID);
    const strict = presets.find((preset) => preset.id === module.PUMP_FADE_STRICT_PRESET_ID);

    expect(balanced?.thresholds.candidate).toMatchObject({
      minPriceMove1mPct: 0.9,
      minPriceMove3mPct: 2.0,
      minPriceMove5mPct: 3.8,
      minPriceMove15mPct: 6.0,
      minVolumeBurstRatio: 2.2,
      minTurnoverBurstRatio: 2.2,
      maxUniverseRank: 3,
      minTurnover24hUsd: 35_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 5_000_000,
      minTrades1m: 50,
      maxSpreadBps: 20,
      minDistanceFromLow24hPct: 8,
      minNearDepthUsd: 30_000,
      candidateScoreMin: 1.4,
    });
    expect(strict?.thresholds.candidate).toMatchObject({
      minPriceMove1mPct: 1.0,
      minPriceMove3mPct: 2.2,
      minPriceMove5mPct: 4.2,
      minPriceMove15mPct: 6.5,
      minVolumeBurstRatio: 2.4,
      minTurnoverBurstRatio: 2.4,
      maxUniverseRank: 3,
      minTurnover24hUsd: 45_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 6_000_000,
      minTrades1m: 60,
      maxSpreadBps: 18,
      minDistanceFromLow24hPct: 9,
      minNearDepthUsd: 40_000,
      candidateScoreMin: 1.48,
    });
  });
});
