import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { FIXED_ENTRY_TIMEOUT_SEC, GLOBAL_REARM_CANDLE_MS } from "./rearmPolicy.js";
import { DEFAULT_BOT_ID, getBotDefinition, type BotConfig } from "../bots/registry.js";

const symbolSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((s) => /^[A-Z0-9]{2,28}USDT$/.test(s) && !s.includes("-"), {
    message: "Symbol must match USDT perpetual format like BTCUSDT or 1000PEPEUSDT",
  });

const universeSchema = z
  .object({
    selectedId: z.string().max(120).default(""),
    symbols: z.array(symbolSchema).min(1).max(1000),
  })
  .strict();

const executionProfileSchema = z
  .object({
    execution: z
      .object({
        mode: z.enum(["paper", "demo", "real", "empty"]),
      })
      .strict(),
    paper: z
      .object({
        enabled: z.boolean(),
        directionMode: z.enum(["both", "long", "short"]),
        marginUSDT: z.number().finite().min(0),
        leverage: z.number().finite().min(1).max(1000),
        makerFeeRate: z.number().finite().min(0).max(0.01),
        maxDailyLossUSDT: z.number().finite().min(0).max(1_000_000_000),
      })
      .strict(),
    riskLimits: z
      .object({
        maxTradesPerDay: z.number().int().min(1).max(1_000_000),
        maxLossPerDayUsdt: z.number().finite().positive().nullable(),
        maxLossPerSessionUsdt: z.number().finite().positive().nullable(),
        maxConsecutiveErrors: z.number().int().min(1).max(1_000_000),
        burstWindowSec: z.number().int().min(1).max(3_600),
        maxBurstEntriesPerSide: z.number().int().min(1).max(1_000_000),
      })
      .strict(),
  })
  .strict();

const storedStateSchema = z
  .object({
    selectedBotId: z.string().min(1).max(120),
    selectedBotPresetId: z.string().min(1).max(120),
    selectedExecutionProfileId: z.string().min(1).max(120),
    universe: universeSchema,
    botConfig: z.unknown(),
    executionProfile: executionProfileSchema,
  })
  .strict();

type StoredConfigState = {
  selectedBotId: string;
  selectedBotPresetId: string;
  selectedExecutionProfileId: string;
  universe: z.infer<typeof universeSchema>;
  botConfig: BotConfig;
  executionProfile: z.infer<typeof executionProfileSchema>;
};
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
type ExecutionProfilePatch = {
  execution?: Partial<ExecutionProfile["execution"]>;
  paper?: Partial<ExecutionProfile["paper"]>;
  riskLimits?: Partial<ExecutionProfile["riskLimits"]>;
};

export type RuntimeConfig = {
  selectedBotId: string;
  selectedBotPresetId: string;
  selectedExecutionProfileId: string;
  universe: z.infer<typeof universeSchema> & { klineTfMin: number };
  botConfig: BotConfig;
  executionProfile: ExecutionProfile;
  fundingCooldown: BotConfig["fundingCooldown"];
  signals: BotConfig["signals"];
  execution: ExecutionProfile["execution"];
  paper: {
    enabled: boolean;
    directionMode: "both" | "long" | "short";
    marginUSDT: number;
    leverage: number;
    entryOffsetPct: number;
    entryTimeoutSec: number;
    tpRoiPct: number;
    slRoiPct: number;
    makerFeeRate: number;
    applyFunding: boolean;
    rearmDelayMs: number;
    maxDailyLossUSDT: number;
  };
  riskLimits: ExecutionProfile["riskLimits"];
};

export type RuntimeConfigPatch = Partial<{
  selectedBotId: string;
  selectedBotPresetId: string;
  selectedExecutionProfileId: string;
  universe: Partial<StoredConfigState["universe"]> & { klineTfMin?: number };
  botConfig: Partial<BotConfig>;
  executionProfile: Partial<ExecutionProfile>;
  fundingCooldown: Partial<BotConfig["fundingCooldown"]>;
  signals: Partial<BotConfig["signals"]>;
  execution: Partial<ExecutionProfile["execution"]>;
  paper: Partial<RuntimeConfig["paper"]> & { rearmSec?: number };
  riskLimits: Partial<ExecutionProfile["riskLimits"]>;
}>;

function deepClone<T>(x: T): T {
  return structuredClone(x);
}

const CONFIG_FILE_PATH = path.resolve(process.cwd(), "data", "config.json");

function ensureDataDir() {
  fs.mkdirSync(path.dirname(CONFIG_FILE_PATH), { recursive: true });
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

function normalizePositiveInt(value: unknown, fallback: number, min = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const n = Math.floor(parsed);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function normalizeLossLimit(value: unknown, fallback: number | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return null;
  return n;
}

function stripLegacyKeys(target: Record<string, unknown>) {
  const removed = ["optimizer", "\u0074apeId", "\u0074apeIds", "\u0074apesDir"];
  for (const key of removed) delete (target as any)[key];
}

function defaultBotConfig(botId: string): BotConfig {
  const bot = getBotDefinition(botId);
  return deepClone(bot.defaults);
}

function defaultExecutionProfile(): ExecutionProfile {
  return {
    execution: { mode: "demo" },
    paper: {
      enabled: CONFIG.paper.enabled,
      directionMode: CONFIG.paper.directionMode,
      marginUSDT: CONFIG.paper.marginUSDT,
      leverage: CONFIG.paper.leverage,
      makerFeeRate: CONFIG.paper.makerFeeRate,
      maxDailyLossUSDT: CONFIG.paper.maxDailyLossUSDT,
    },
    riskLimits: {
      maxTradesPerDay: CONFIG.riskLimits.maxTradesPerDay,
      maxLossPerDayUsdt: CONFIG.riskLimits.maxLossPerDayUsdt,
      maxLossPerSessionUsdt: CONFIG.riskLimits.maxLossPerSessionUsdt,
      maxConsecutiveErrors: CONFIG.riskLimits.maxConsecutiveErrors,
      burstWindowSec: CONFIG.riskLimits.burstWindowSec,
      maxBurstEntriesPerSide: CONFIG.riskLimits.maxBurstEntriesPerSide,
    },
  };
}

function toStoredState(raw: any): StoredConfigState {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  stripLegacyKeys(source);

  const selectedBotId = DEFAULT_BOT_ID;
  const botDefinition = getBotDefinition(selectedBotId);

  const legacyPaper = source.paper ?? {};
  const legacyExecution = source.execution ?? {};
  const legacyUniverse = source.universe ?? {};
  const legacyRiskLimits = source.riskLimits ?? {};

  const botConfigInput = source.botConfig ?? defaultBotConfig(selectedBotId);

  const executionProfileInput = source.executionProfile ?? {
    execution: {
      mode: legacyExecution.mode ?? "demo",
    },
    paper: {
      enabled: legacyPaper.enabled ?? CONFIG.paper.enabled,
      directionMode: legacyPaper.directionMode ?? (legacyPaper.longOnly ? "long" : CONFIG.paper.directionMode),
      marginUSDT: legacyPaper.marginUSDT ?? CONFIG.paper.marginUSDT,
      leverage: legacyPaper.leverage ?? CONFIG.paper.leverage,
      makerFeeRate: legacyPaper.makerFeeRate ?? CONFIG.paper.makerFeeRate,
      maxDailyLossUSDT: legacyPaper.maxDailyLossUSDT ?? CONFIG.paper.maxDailyLossUSDT,
    },
    riskLimits: {
      maxTradesPerDay: normalizePositiveInt(legacyRiskLimits.maxTradesPerDay, CONFIG.riskLimits.maxTradesPerDay),
      maxLossPerDayUsdt: normalizeLossLimit(legacyRiskLimits.maxLossPerDayUsdt, CONFIG.riskLimits.maxLossPerDayUsdt),
      maxLossPerSessionUsdt: normalizeLossLimit(legacyRiskLimits.maxLossPerSessionUsdt, CONFIG.riskLimits.maxLossPerSessionUsdt),
      maxConsecutiveErrors: normalizePositiveInt(legacyRiskLimits.maxConsecutiveErrors, CONFIG.riskLimits.maxConsecutiveErrors),
      burstWindowSec: normalizePositiveInt(legacyRiskLimits.burstWindowSec, CONFIG.riskLimits.burstWindowSec),
      maxBurstEntriesPerSide: normalizePositiveInt(legacyRiskLimits.maxBurstEntriesPerSide, CONFIG.riskLimits.maxBurstEntriesPerSide),
    },
  };

  const normalizedBot = botDefinition.normalizeBotConfig(botConfigInput);
  botDefinition.validateBotConfig(normalizedBot);

  const executionProfile = executionProfileSchema.parse(executionProfileInput);
  const parsed = storedStateSchema.parse({
    selectedBotId,
    selectedBotPresetId: typeof source.selectedBotPresetId === "string" && source.selectedBotPresetId.trim()
      ? source.selectedBotPresetId.trim()
      : "default",
    selectedExecutionProfileId: typeof source.selectedExecutionProfileId === "string" && source.selectedExecutionProfileId.trim()
      ? source.selectedExecutionProfileId.trim()
      : "default",
    universe: {
      selectedId: typeof legacyUniverse.selectedId === "string" ? legacyUniverse.selectedId : "",
      symbols: Array.isArray(legacyUniverse.symbols) ? legacyUniverse.symbols : Array.from(CONFIG.symbols),
    },
    botConfig: normalizedBot,
    executionProfile,
  });
  return {
    selectedBotId: parsed.selectedBotId,
    selectedBotPresetId: parsed.selectedBotPresetId,
    selectedExecutionProfileId: parsed.selectedExecutionProfileId,
    universe: parsed.universe,
    botConfig: normalizedBot,
    executionProfile: parsed.executionProfile,
  };
}

function resolveRuntimeConfig(state: StoredConfigState): RuntimeConfig {
  const strategy = state.botConfig.strategy as Record<string, unknown>;
  const klineTfMin = Number(
    typeof strategy.klineTfMin === "number" ? strategy.klineTfMin : strategy.signalTfMin,
  );
  const entryOffsetPct = Number(strategy.entryOffsetPct ?? CONFIG.paper.entryOffsetPct);
  const entryTimeoutSec = FIXED_ENTRY_TIMEOUT_SEC;
  const tpRoiPct = Number(strategy.tpRoiPct ?? CONFIG.paper.tpRoiPct);
  const slRoiPct = Number(strategy.slRoiPct ?? CONFIG.paper.slRoiPct);
  const applyFunding = Boolean(strategy.applyFunding ?? CONFIG.paper.applyFunding);
  const rearmDelayMs = GLOBAL_REARM_CANDLE_MS;
  return {
    selectedBotId: state.selectedBotId,
    selectedBotPresetId: state.selectedBotPresetId,
    selectedExecutionProfileId: state.selectedExecutionProfileId,
    universe: {
      ...state.universe,
      klineTfMin: Number.isFinite(klineTfMin) && klineTfMin > 0 ? Math.floor(klineTfMin) : CONFIG.klineTfMin,
    },
    botConfig: deepClone(state.botConfig),
    executionProfile: deepClone(state.executionProfile),
    fundingCooldown: deepClone(state.botConfig.fundingCooldown),
    signals: deepClone(state.botConfig.signals),
    execution: deepClone(state.executionProfile.execution),
    paper: {
      enabled: state.executionProfile.paper.enabled,
      directionMode: state.executionProfile.paper.directionMode,
      marginUSDT: state.executionProfile.paper.marginUSDT,
      leverage: state.executionProfile.paper.leverage,
      entryOffsetPct: Math.max(0, Number.isFinite(entryOffsetPct) ? entryOffsetPct : CONFIG.paper.entryOffsetPct),
      entryTimeoutSec: Math.max(1, Number.isFinite(entryTimeoutSec) ? Math.floor(entryTimeoutSec) : CONFIG.paper.entryTimeoutSec),
      tpRoiPct: Math.max(0, Number.isFinite(tpRoiPct) ? tpRoiPct : CONFIG.paper.tpRoiPct),
      slRoiPct: Math.max(0, Number.isFinite(slRoiPct) ? slRoiPct : CONFIG.paper.slRoiPct),
      makerFeeRate: state.executionProfile.paper.makerFeeRate,
      applyFunding,
      rearmDelayMs: Math.max(0, Number.isFinite(rearmDelayMs) ? Math.floor(rearmDelayMs) : CONFIG.paper.rearmDelayMs),
      maxDailyLossUSDT: state.executionProfile.paper.maxDailyLossUSDT,
    },
    riskLimits: deepClone(state.executionProfile.riskLimits),
  };
}

function tryLoadFromDisk(): StoredConfigState | null {
  if (!fs.existsSync(CONFIG_FILE_PATH)) return null;
  const rawText = fs.readFileSync(CONFIG_FILE_PATH, "utf8");
  return toStoredState(JSON.parse(rawText));
}

function quarantineBadConfigFile() {
  try {
    const bad = path.resolve(path.dirname(CONFIG_FILE_PATH), `config.invalid.${Date.now()}.json`);
    fs.renameSync(CONFIG_FILE_PATH, bad);
  } catch {
    // ignore
  }
}

function defaultState(): StoredConfigState {
  return toStoredState({
    selectedBotId: DEFAULT_BOT_ID,
    selectedBotPresetId: "default",
    selectedExecutionProfileId: "default",
    universe: {
      selectedId: "",
      symbols: Array.from(CONFIG.symbols),
    },
    botConfig: defaultBotConfig(DEFAULT_BOT_ID),
    executionProfile: defaultExecutionProfile(),
  });
}

function mergeExecutionProfile(base: ExecutionProfile, patch?: ExecutionProfilePatch): ExecutionProfile {
  if (!patch) return base;
  return executionProfileSchema.parse({
    execution: {
      mode: patch.execution?.mode ?? base.execution.mode,
    },
    paper: {
      enabled: patch.paper?.enabled ?? base.paper.enabled,
      directionMode: patch.paper?.directionMode ?? base.paper.directionMode,
      marginUSDT: patch.paper?.marginUSDT ?? base.paper.marginUSDT,
      leverage: patch.paper?.leverage ?? base.paper.leverage,
      makerFeeRate: patch.paper?.makerFeeRate ?? base.paper.makerFeeRate,
      maxDailyLossUSDT: patch.paper?.maxDailyLossUSDT ?? base.paper.maxDailyLossUSDT,
    },
    riskLimits: {
      maxTradesPerDay: patch.riskLimits?.maxTradesPerDay ?? base.riskLimits.maxTradesPerDay,
      maxLossPerDayUsdt: patch.riskLimits?.maxLossPerDayUsdt ?? base.riskLimits.maxLossPerDayUsdt,
      maxLossPerSessionUsdt: patch.riskLimits?.maxLossPerSessionUsdt ?? base.riskLimits.maxLossPerSessionUsdt,
      maxConsecutiveErrors: patch.riskLimits?.maxConsecutiveErrors ?? base.riskLimits.maxConsecutiveErrors,
      burstWindowSec: patch.riskLimits?.burstWindowSec ?? base.riskLimits.burstWindowSec,
      maxBurstEntriesPerSide: patch.riskLimits?.maxBurstEntriesPerSide ?? base.riskLimits.maxBurstEntriesPerSide,
    },
  });
}

class ConfigStore extends EventEmitter {
  private state: StoredConfigState;

  constructor(initial: StoredConfigState) {
    super();
    this.state = initial;
  }

  get(): RuntimeConfig {
    return resolveRuntimeConfig(this.state);
  }

  getStoredState(): StoredConfigState {
    return deepClone(this.state);
  }

  getFilePath(): string {
    return CONFIG_FILE_PATH;
  }

  persist(): void {
    writeFileAtomic(CONFIG_FILE_PATH, JSON.stringify(this.state, null, 2));
  }

  setSelections(next: { selectedBotId?: string; selectedBotPresetId?: string; selectedExecutionProfileId?: string }): RuntimeConfig {
    const selectedBotId = DEFAULT_BOT_ID;
    const botChanged = selectedBotId !== this.state.selectedBotId;
    const selectedBotPresetId = next.selectedBotPresetId?.trim() || (botChanged ? "default" : this.state.selectedBotPresetId);
    const selectedExecutionProfileId = next.selectedExecutionProfileId?.trim() || this.state.selectedExecutionProfileId;
    this.state = {
      ...this.state,
      selectedBotId,
      selectedBotPresetId,
      selectedExecutionProfileId,
      botConfig: botChanged ? defaultBotConfig(selectedBotId) : this.state.botConfig,
    };
    this.emit("change", this.get(), { universeChanged: false });
    return this.get();
  }

  applyProfiles(args: { botConfig?: BotConfig; executionProfile?: ExecutionProfile }): RuntimeConfig {
    const nextState: StoredConfigState = {
      ...this.state,
      botConfig: args.botConfig ? getBotDefinition(this.state.selectedBotId).normalizeBotConfig(args.botConfig) : this.state.botConfig,
      executionProfile: args.executionProfile ? executionProfileSchema.parse(args.executionProfile) : this.state.executionProfile,
    };
    getBotDefinition(nextState.selectedBotId).validateBotConfig(nextState.botConfig);
    this.state = nextState;
    this.emit("change", this.get(), { universeChanged: false });
    return this.get();
  }

  update(patchRaw: unknown): RuntimeConfig {
    const patch = (patchRaw && typeof patchRaw === "object" ? patchRaw : {}) as RuntimeConfigPatch;

    const universePatch = patch.universe ?? {};
    const legacyPaperPatch = patch.paper ?? {};
    const legacySignalsPatch = patch.signals ?? {};
    const legacyFundingPatch = patch.fundingCooldown ?? {};
    const patchBotConfig = (patch.botConfig && typeof patch.botConfig === "object")
      ? patch.botConfig as Record<string, unknown>
      : null;

    const nextBotId = DEFAULT_BOT_ID;
    const botDef = getBotDefinition(nextBotId);
    const includeLegacyExecutionInStrategy = false;
    const botChanged = nextBotId !== this.state.selectedBotId;
    const baseBotConfig = botChanged ? defaultBotConfig(nextBotId) : this.state.botConfig;
    const hasSymbolOverridesPatch = Boolean(
      patchBotConfig && Object.prototype.hasOwnProperty.call(patchBotConfig, "symbolOverrides"),
    );
    const nextSymbolOverrides = hasSymbolOverridesPatch
      ? (patchBotConfig as { symbolOverrides?: unknown }).symbolOverrides
      : (baseBotConfig as { symbolOverrides?: unknown }).symbolOverrides;
    const nextBotConfig = botDef.normalizeBotConfig({
      fundingCooldown: {
        ...baseBotConfig.fundingCooldown,
        ...legacyFundingPatch,
        ...(patch.botConfig?.fundingCooldown ?? {}),
      },
      ...(patch.botConfig && "dataSources" in patch.botConfig
        ? { dataSources: { ...((baseBotConfig as any).dataSources ?? {}), ...((patch.botConfig as any).dataSources ?? {}) } }
        : {}),
      signals: {
        ...(("signals" in baseBotConfig ? (baseBotConfig as Record<string, unknown>).signals : {}) as Record<string, unknown>),
        ...legacySignalsPatch,
        ...(patch.botConfig?.signals ?? {}),
      },
      ...(patch.botConfig && "candidate" in patch.botConfig ? { candidate: { ...((baseBotConfig as any).candidate ?? {}), ...((patch.botConfig as any).candidate ?? {}) } } : {}),
      ...(patch.botConfig && "derivatives" in patch.botConfig ? { derivatives: { ...((baseBotConfig as any).derivatives ?? {}), ...((patch.botConfig as any).derivatives ?? {}) } } : {}),
      ...(patch.botConfig && "exhaustion" in patch.botConfig ? { exhaustion: { ...((baseBotConfig as any).exhaustion ?? {}), ...((patch.botConfig as any).exhaustion ?? {}) } } : {}),
      ...(patch.botConfig && "microstructure" in patch.botConfig ? { microstructure: { ...((baseBotConfig as any).microstructure ?? {}), ...((patch.botConfig as any).microstructure ?? {}) } } : {}),
      ...(patch.botConfig && "observe" in patch.botConfig ? { observe: { ...((baseBotConfig as any).observe ?? {}), ...((patch.botConfig as any).observe ?? {}) } } : {}),
      strategy: {
        ...baseBotConfig.strategy,
        ...(patch.botConfig?.strategy ?? {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.entryOffsetPct != null ? { entryOffsetPct: Number(legacyPaperPatch.entryOffsetPct) } : {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.entryTimeoutSec != null ? { entryTimeoutSec: Math.max(1, Math.floor(Number(legacyPaperPatch.entryTimeoutSec))) } : {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.tpRoiPct != null ? { tpRoiPct: Number(legacyPaperPatch.tpRoiPct) } : {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.slRoiPct != null ? { slRoiPct: Number(legacyPaperPatch.slRoiPct) } : {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.rearmSec != null ? { rearmDelayMs: Math.max(0, Math.floor(Number(legacyPaperPatch.rearmSec) * 1000)) } : {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.rearmDelayMs != null ? { rearmDelayMs: Math.max(0, Math.floor(Number(legacyPaperPatch.rearmDelayMs))) } : {}),
        ...(includeLegacyExecutionInStrategy && legacyPaperPatch.applyFunding != null ? { applyFunding: Boolean(legacyPaperPatch.applyFunding) } : {}),
        ...(universePatch.klineTfMin != null
          ? {
              ...(typeof (baseBotConfig.strategy as any).signalTfMin === "number"
                ? { signalTfMin: Math.max(1, Math.floor(Number(universePatch.klineTfMin))) }
                : { klineTfMin: Math.max(1, Math.floor(Number(universePatch.klineTfMin))) }),
            }
          : {}),
      },
      ...(patch.botConfig && "runtime" in patch.botConfig
        ? { runtime: { ...((baseBotConfig as any).runtime ?? {}), ...((patch.botConfig as any).runtime ?? {}) } }
        : {}),
      ...(hasSymbolOverridesPatch || nextSymbolOverrides != null
        ? { symbolOverrides: nextSymbolOverrides }
        : {}),
    });
    botDef.validateBotConfig(nextBotConfig);

    const executionPatch: ExecutionProfilePatch = {};
    if (patch.executionProfile?.execution || patch.execution?.mode != null) {
      executionPatch.execution = {
        mode: (patch.execution?.mode ?? patch.executionProfile?.execution?.mode ?? this.state.executionProfile.execution.mode),
      };
    }
    if (patch.executionProfile?.paper || Object.keys(legacyPaperPatch).length > 0) {
      executionPatch.paper = {
        ...(patch.executionProfile?.paper ?? {}),
        ...(legacyPaperPatch.enabled != null ? { enabled: Boolean(legacyPaperPatch.enabled) } : {}),
        ...(legacyPaperPatch.directionMode != null ? { directionMode: legacyPaperPatch.directionMode as "both" | "long" | "short" } : {}),
        ...(legacyPaperPatch.marginUSDT != null ? { marginUSDT: Number(legacyPaperPatch.marginUSDT) } : {}),
        ...(legacyPaperPatch.leverage != null ? { leverage: Number(legacyPaperPatch.leverage) } : {}),
        ...(legacyPaperPatch.makerFeeRate != null ? { makerFeeRate: Number(legacyPaperPatch.makerFeeRate) } : {}),
        ...(legacyPaperPatch.maxDailyLossUSDT != null ? { maxDailyLossUSDT: Math.max(0, Number(legacyPaperPatch.maxDailyLossUSDT)) } : {}),
      };
    }
    if (patch.executionProfile?.riskLimits || patch.riskLimits) {
      executionPatch.riskLimits = {
        ...(patch.executionProfile?.riskLimits ?? {}),
        ...(patch.riskLimits ?? {}),
      };
    }
    const executionProfile = mergeExecutionProfile(this.state.executionProfile, executionPatch);

    const parsed = storedStateSchema.parse({
      selectedBotId: nextBotId,
      selectedBotPresetId: patch.selectedBotPresetId?.trim() || (botChanged ? "default" : this.state.selectedBotPresetId),
      selectedExecutionProfileId: patch.selectedExecutionProfileId?.trim() || this.state.selectedExecutionProfileId,
      universe: {
        selectedId: universePatch.selectedId ?? this.state.universe.selectedId,
        symbols: Array.isArray(universePatch.symbols) ? universePatch.symbols : this.state.universe.symbols,
      },
      botConfig: nextBotConfig,
      executionProfile,
    });
    const nextState: StoredConfigState = {
      selectedBotId: parsed.selectedBotId,
      selectedBotPresetId: parsed.selectedBotPresetId,
      selectedExecutionProfileId: parsed.selectedExecutionProfileId,
      universe: parsed.universe,
      botConfig: nextBotConfig,
      executionProfile: parsed.executionProfile,
    };

    const prevResolved = this.get();
    this.state = nextState;
    const nextResolved = this.get();
    const universeChanged =
      JSON.stringify(prevResolved.universe.symbols) !== JSON.stringify(nextResolved.universe.symbols) ||
      prevResolved.universe.selectedId !== nextResolved.universe.selectedId ||
      prevResolved.universe.klineTfMin !== nextResolved.universe.klineTfMin;
    this.emit("change", nextResolved, { universeChanged });
    return nextResolved;
  }
}

let initialState = defaultState();
try {
  const loaded = tryLoadFromDisk();
  if (loaded) initialState = loaded;
} catch {
  quarantineBadConfigFile();
  initialState = defaultState();
}

export const configStore = new ConfigStore(initialState);
export const RUNTIME_CONFIG_FILE = CONFIG_FILE_PATH;
