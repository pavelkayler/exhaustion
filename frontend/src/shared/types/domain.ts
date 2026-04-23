export type SessionState = "STOPPED" | "RUNNING" | "STOPPING" | "PAUSED" | "PAUSING" | "RESUMING";

export type ConnStatus = "CONNECTING" | "RECONNECTING" | "CONNECTED" | "DISCONNECTED";

export type StreamsState = {
  streamsEnabled: boolean;
  bybitConnected: boolean;
};

export type BrokerRuntimeStats = {
  globalOpenPositions: number;
  globalOpenOrders: number;
  pendingEntries: number;
  lastReconcileAtMs: number | null;
  currentBalanceUsdt: number | null;
  startBalanceUsdt: number | null;
  lastExecTimeMs: number | null;
  currentBalanceUpdatedAtMs: number | null;
};

export type BotStats = {
  openPositions: number;
  pendingOrders: number;
  unrealizedPnl: number;
  closedTrades: number;
  wins: number;
  losses: number;
  netRealized: number;
  feesPaid: number;
  fundingAccrued: number;
  executionMode: "paper" | "demo" | "real";
  demoStats?: BrokerRuntimeStats | null;
  realStats?: BrokerRuntimeStats | null;
};

export type AvailableWsSymbol = {
  symbol: string;
  markPrice: number;
  lastPrice: number | null;
  updatedAt: number;
};

export type SymbolRow = {
  symbol: string;
  updatedAt: number | null;
  markPrice: number;
  lastPrice: number | null;
  prevCandleClose?: number | null;
  signal?: "LONG" | "SHORT" | null;
  signalReason?: string;
  paperStatus?: string | null;
  paperUnrealizedPnl?: number | null;
  shortSignalState?: string | null;
  shortSignalStage?: string | null;
  shortTotalScore?: number | null;
  shortSummaryReason?: string | null;
  shortOiMove5mPct?: number | null;
  shortOiMove15mPct?: number | null;
  shortOiMove1hPct?: number | null;
  paperSide?: string | null;
  paperEntryPrice?: number | null;
  paperTpPrice?: number | null;
  paperSlPrice?: number | null;
  paperQty?: number | null;
  [key: string]: unknown;
};

export type LogEvent = {
  ts: number;
  type: string;
  symbol?: string | null;
  payload?: unknown;
};

export type RuntimeConfig = {
  selectedBotId?: string;
  selectedBotPresetId?: string;
  selectedExecutionProfileId?: string;
  botConfig?: {
    observe?: {
      useHotRegimeTracking?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  universe: {
    selectedId: string;
    symbols: string[];
    klineTfMin?: number;
    [key: string]: unknown;
  };
  paper?: {
    marginUSDT?: number;
    entryOffsetPct?: number;
    leverage?: number;
    tpRoiPct?: number;
    slRoiPct?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ConfigResponse = {
  config: RuntimeConfig;
  applied?: {
    universeSymbolsCount: number;
    universeSelectedId: string;
  } | null;
};

export type SignalThresholds = {
  candidate: {
    minPriceMove1mPct: number;
    minPriceMove3mPct: number;
    minPriceMove5mPct: number;
    minPriceMove15mPct: number;
    minVolumeBurstRatio: number;
    minTurnoverBurstRatio: number;
    maxUniverseRank: number;
    minTurnover24hUsd: number;
    maxTurnover24hUsd: number | null;
    minOpenInterestValueUsd: number;
    minTrades1m: number;
    maxSpreadBps: number;
    minDistanceFromLow24hPct: number;
    minNearDepthUsd: number;
    candidateScoreMin: number;
  };
  derivatives: {
    minOiMove1mPct: number;
    minOiMove5mPct: number;
    minOiAccelerationPct: number;
    minFundingAbsPct: number;
    useLongShortRatio: boolean;
    minLongShortRatio: number;
    longShortRatioWeight: number;
    minShortLiquidationUsd60s: number;
    minShortLiquidationBurstRatio60s: number;
    minShortLiquidationImbalance60s: number;
    derivativesScoreMin: number;
  };
  exhaustion: {
    maxPriceContinuation30sPct: number;
    maxPriceContinuation1mPct: number;
    maxOiAccelerationPct: number;
    minNegativeCvdDelta: number;
    minNegativeCvdImbalance: number;
    exhaustionScoreMin: number;
  };
  microstructure: {
    minAskToBidDepthRatio: number;
    minSellSideImbalance: number;
    maxNearestAskWallBps: number;
    minNearestBidWallBps: number;
    maxSpreadBps: number;
    minNearDepthUsd: number;
    microstructureScoreMin: number;
  };
  observe: {
    totalScoreMin: number;
  };
};

export type SignalPreset = {
  id: string;
  name: string;
  thresholds: SignalThresholds;
  createdAt: number;
  updatedAt: number;
};

export type SignalPresetsResponse = {
  selectedPresetId: string | null;
  currentThresholds: SignalThresholds;
  presets: SignalPreset[];
  savedPreset?: SignalPreset | null;
  deleted?: boolean;
  config?: RuntimeConfig;
  status?: StatusResponse;
  restarted?: boolean;
};

export type ManualTestOrderResponse = {
  ok?: boolean;
  accepted: boolean;
  message: string;
  reason?: string;
  tracked?: boolean;
  retCode?: number | null;
  retMsg?: string | null;
  row?: SymbolRow;
  [key: string]: unknown;
};

export type StatusResponse = {
  sessionState: SessionState;
  sessionId: string | null;
  eventsFile: string | null;
  runningSinceMs: number | null;
  runtimeMessage: string | null;
  runningBotId: string | null;
  runningBotName: string | null;
};

export type ExecutorExitMode = "full" | "partial_and_trailing" | "trailing";
export type ExecutorStatus = "stopped" | "starting" | "running" | "waiting_session" | "error";

export type ExecutorSettings = {
  mode: "demo" | "real";
  maxUsdt: number;
  leverage: number;
  tpPct: number;
  slPct: number;
  firstOrderOffsetPct: number;
  gridOrdersCount: number;
  gridStepPct: number;
  orderAliveMin: number;
  cooldownMin: number;
  trackCandidateSignalsForResearch: boolean;
  takeCandidateSignalsInLiveExecution: boolean;
  takeFinalSignals: boolean;
  cancelActivePositionOrders: boolean;
  exit: ExecutorExitMode;
};

export type ExecutorStatusResponse = {
  settings: ExecutorSettings;
  activeSettings: ExecutorSettings | null;
  desiredRunning: boolean;
  status: ExecutorStatus;
  error: string | null;
  updatedAt: number | null;
};

export type ShortOiSpikeWatchlistRecord = {
  symbol: string;
  turnover24hUsd: number | null;
  oiMove5mPct: number | null;
  oiMove15mPct: number | null;
  oiMove1hPct: number | null;
  shortSignalState: string | null;
  shortSignalStage: string | null;
  shortTotalScore: number | null;
  shortSummaryReason: string | null;
  signalOrdinal: number;
  coinglassUrl: string;
};

export type ShortSignalRowsFilter = {
  showRejected: boolean;
  showCandidate: boolean;
  showWatchlist: boolean;
  showFinal: boolean;
};

export type WsRpcAction =
  | "session.status"
  | "session.start"
  | "session.stop"
  | "session.pause"
  | "session.resume"
  | "config.get"
  | "config.update"
  | "manual_order.submit";

export type WsMessage =
  | { type: "hello"; serverTime: number }
  | {
      type: "snapshot";
      payload: {
        sessionState: SessionState;
        sessionId: string | null;
        eventsFile?: string | null;
        runningSinceMs?: number | null;
        runtimeMessage?: string | null;
        runningBotId?: string | null;
        runningBotName?: string | null;
        rows: SymbolRow[];
        botStats: BotStats;
        universeSelectedId: string;
        universeSymbolsCount: number;
        availableWsSymbols: string[];
        availableWsRows?: AvailableWsSymbol[];
      } & StreamsState;
    }
  | {
      type: "tick";
      payload: {
        serverTime: number;
        rows: SymbolRow[];
        botStats: BotStats;
        universeSelectedId: string;
        universeSymbolsCount: number;
        availableWsSymbols: string[];
        availableWsRows?: AvailableWsSymbol[];
      };
    }
  | { type: "streams_state"; payload: StreamsState }
  | { type: "events_tail"; payload: { limit: number; count: number; events: LogEvent[] } }
  | { type: "events_append"; payload: { event: LogEvent } }
  | { type: "rpc_result"; id: string; action: WsRpcAction; ok: boolean; payload?: unknown; error?: string | null }
  | { type: "error"; message: string };
