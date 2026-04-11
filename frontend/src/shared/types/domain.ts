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

export type ManualTestOrderResponse = {
  ok?: boolean;
  accepted: boolean;
  message: string;
  reason?: string;
  tracked?: boolean;
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


export type WsMessage =
  | { type: "hello"; serverTime: number }
  | {
      type: "snapshot";
      payload: {
        sessionState: SessionState;
        sessionId: string | null;
        runningSinceMs?: number | null;
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
  | { type: "error"; message: string };
