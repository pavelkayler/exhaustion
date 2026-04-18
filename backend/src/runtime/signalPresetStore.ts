import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_BOT_ID, getBotDefinition, type BotConfig } from "../bots/registry.js";

export const DEFAULT_SIGNAL_PRESET_ID = "default";

const signalThresholdsSchema = z.object({
  candidate: z.object({
    minPriceMove1mPct: z.number().finite().min(0),
    minPriceMove3mPct: z.number().finite().min(0),
    minPriceMove5mPct: z.number().finite().min(0),
    minPriceMove15mPct: z.number().finite().min(0),
    minVolumeBurstRatio: z.number().finite().min(0),
    minTurnoverBurstRatio: z.number().finite().min(0),
    maxUniverseRank: z.number().int().min(1),
    minTurnover24hUsd: z.number().finite().min(0),
    maxTurnover24hUsd: z.number().finite().positive().nullable(),
    minOpenInterestValueUsd: z.number().finite().min(0),
    minTrades1m: z.number().int().min(0),
    maxSpreadBps: z.number().finite().min(0),
    minDistanceFromLow24hPct: z.number().finite().min(0),
    minNearDepthUsd: z.number().finite().min(0),
    candidateScoreMin: z.number().finite().min(0),
  }).strict(),
  derivatives: z.object({
    minOiMove1mPct: z.number().finite().min(0),
    minOiMove5mPct: z.number().finite().min(0),
    minOiAccelerationPct: z.number().finite().min(0),
    minFundingAbsPct: z.number().finite().min(0),
    useLongShortRatio: z.boolean(),
    minLongShortRatio: z.number().finite().min(0),
    longShortRatioWeight: z.number().finite().min(0),
    minShortLiquidationUsd60s: z.number().finite().min(0),
    minShortLiquidationBurstRatio60s: z.number().finite().min(0),
    minShortLiquidationImbalance60s: z.number().finite().min(0),
    derivativesScoreMin: z.number().finite().min(0),
  }).strict(),
  exhaustion: z.object({
    maxPriceContinuation30sPct: z.number().finite().min(0.0001),
    maxPriceContinuation1mPct: z.number().finite().min(0.0001),
    maxOiAccelerationPct: z.number().finite().min(0.0001),
    minNegativeCvdDelta: z.number().finite().min(0),
    minNegativeCvdImbalance: z.number().finite().min(0),
    exhaustionScoreMin: z.number().finite().min(0),
  }).strict(),
  microstructure: z.object({
    minAskToBidDepthRatio: z.number().finite().min(0.0001),
    minSellSideImbalance: z.number().finite().min(0),
    maxNearestAskWallBps: z.number().finite().min(0.0001),
    minNearestBidWallBps: z.number().finite().min(0),
    maxSpreadBps: z.number().finite().min(0.0001),
    minNearDepthUsd: z.number().finite().min(0),
    microstructureScoreMin: z.number().finite().min(0),
  }).strict(),
  observe: z.object({
    totalScoreMin: z.number().finite().min(0),
  }).strict(),
}).strict();

const signalPresetSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  thresholds: signalThresholdsSchema,
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
}).strict();

const storedPresetStateSchema = z.object({
  presets: z.array(signalPresetSchema),
}).strict();

export type SignalThresholds = z.infer<typeof signalThresholdsSchema>;
export type SignalPreset = z.infer<typeof signalPresetSchema>;

const SIGNAL_PRESETS_FILE_PATH = path.resolve(process.cwd(), "data", "short-signal-presets.json");

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function ensureDataDir() {
  fs.mkdirSync(path.dirname(SIGNAL_PRESETS_FILE_PATH), { recursive: true });
}

function writeFileAtomic(filePath: string, content: string) {
  ensureDataDir();
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
  fs.renameSync(tmp, filePath);
}

function buildThresholdsBotConfig(base: BotConfig, thresholds: SignalThresholds): BotConfig {
  const botDef = getBotDefinition(DEFAULT_BOT_ID);
  return botDef.normalizeBotConfig({
    ...base,
    candidate: {
      ...base.candidate,
      ...thresholds.candidate,
    },
    derivatives: {
      ...base.derivatives,
      ...thresholds.derivatives,
    },
    exhaustion: {
      ...base.exhaustion,
      ...thresholds.exhaustion,
    },
    microstructure: {
      ...base.microstructure,
      ...thresholds.microstructure,
    },
    observe: {
      ...base.observe,
      ...thresholds.observe,
    },
  });
}

export function extractSignalThresholds(botConfig: BotConfig): SignalThresholds {
  return signalThresholdsSchema.parse({
    candidate: {
      ...botConfig.candidate,
    },
    derivatives: {
      ...botConfig.derivatives,
    },
    exhaustion: {
      ...botConfig.exhaustion,
    },
    microstructure: {
      ...botConfig.microstructure,
    },
    observe: {
      totalScoreMin: botConfig.observe.totalScoreMin,
    },
  });
}

export function normalizeSignalThresholds(raw: unknown, baseBotConfig?: BotConfig): SignalThresholds {
  const botDef = getBotDefinition(DEFAULT_BOT_ID);
  const base = deepClone(baseBotConfig ?? botDef.defaults);
  const normalizedBotConfig = buildThresholdsBotConfig(
    base,
    signalThresholdsSchema.parse(raw),
  );
  botDef.validateBotConfig(normalizedBotConfig);
  return extractSignalThresholds(normalizedBotConfig);
}

export function buildBotConfigPatchFromThresholds(thresholds: SignalThresholds): Record<string, unknown> {
  return {
    candidate: deepClone(thresholds.candidate),
    derivatives: deepClone(thresholds.derivatives),
    exhaustion: deepClone(thresholds.exhaustion),
    microstructure: deepClone(thresholds.microstructure),
    observe: deepClone(thresholds.observe),
  };
}

function makeDefaultPreset(): SignalPreset {
  const botDef = getBotDefinition(DEFAULT_BOT_ID);
  const now = Date.now();
  return {
    id: DEFAULT_SIGNAL_PRESET_ID,
    name: "Default",
    thresholds: extractSignalThresholds(botDef.defaults),
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizePreset(raw: unknown, existingCreatedAt?: number): SignalPreset {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const thresholds = normalizeSignalThresholds(source.thresholds);
  const now = Date.now();
  return signalPresetSchema.parse({
    id: String(source.id ?? "").trim(),
    name: String(source.name ?? "").trim(),
    thresholds,
    createdAt: existingCreatedAt && existingCreatedAt > 0 ? existingCreatedAt : now,
    updatedAt: now,
  });
}

function tryLoadFromDisk(): { presets: SignalPreset[] } | null {
  if (!fs.existsSync(SIGNAL_PRESETS_FILE_PATH)) return null;
  const raw = JSON.parse(fs.readFileSync(SIGNAL_PRESETS_FILE_PATH, "utf8"));
  const parsed = storedPresetStateSchema.parse(raw);
  return {
    presets: parsed.presets.map((preset) => sanitizePreset(preset, preset.createdAt)),
  };
}

function defaultState(): { presets: SignalPreset[] } {
  return { presets: [makeDefaultPreset()] };
}

class SignalPresetStore {
  private state: { presets: SignalPreset[] };

  constructor(initial: { presets: SignalPreset[] }) {
    this.state = initial;
  }

  private ensureDefaultPreset(): void {
    if (this.state.presets.some((preset) => preset.id === DEFAULT_SIGNAL_PRESET_ID)) return;
    this.state.presets.unshift(makeDefaultPreset());
  }

  getAll(): SignalPreset[] {
    this.ensureDefaultPreset();
    return this.state.presets
      .slice()
      .sort((left, right) => {
        if (left.id === DEFAULT_SIGNAL_PRESET_ID) return -1;
        if (right.id === DEFAULT_SIGNAL_PRESET_ID) return 1;
        return left.name.localeCompare(right.name);
      })
      .map((preset) => deepClone(preset));
  }

  getById(id: string): SignalPreset | null {
    this.ensureDefaultPreset();
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) return null;
    const preset = this.state.presets.find((entry) => entry.id === normalizedId) ?? null;
    return preset ? deepClone(preset) : null;
  }

  persist(): void {
    this.ensureDefaultPreset();
    writeFileAtomic(
      SIGNAL_PRESETS_FILE_PATH,
      JSON.stringify({ presets: this.state.presets }, null, 2),
    );
  }

  save(input: { id?: string | null; name: string; thresholds: unknown }): SignalPreset {
    this.ensureDefaultPreset();
    const desiredId = String(input.id ?? "").trim();
    const existing = desiredId
      ? this.state.presets.find((preset) => preset.id === desiredId) ?? null
      : null;
    const id = desiredId || `preset_${Date.now()}`;
    const sanitized = sanitizePreset(
      {
        id,
        name: input.name,
        thresholds: input.thresholds,
      },
      existing?.createdAt,
    );

    if (existing) {
      this.state.presets = this.state.presets.map((preset) => preset.id === id ? sanitized : preset);
    } else {
      this.state.presets.push(sanitized);
    }

    this.persist();
    return deepClone(sanitized);
  }

  delete(id: string): { deleted: boolean } {
    this.ensureDefaultPreset();
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId || normalizedId === DEFAULT_SIGNAL_PRESET_ID) {
      return { deleted: false };
    }

    const before = this.state.presets.length;
    this.state.presets = this.state.presets.filter((preset) => preset.id !== normalizedId);
    const deleted = this.state.presets.length !== before;
    if (deleted) this.persist();
    return { deleted };
  }
}

let initialState = defaultState();
try {
  const loaded = tryLoadFromDisk();
  if (loaded) initialState = loaded;
} catch {
  initialState = defaultState();
}

export const signalPresetStore = new SignalPresetStore(initialState);
