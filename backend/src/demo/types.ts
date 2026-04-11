import type { PaperBrokerTickConfigOverride, PaperSide } from "../paper/PaperBroker.js";

export type DemoStats = {
  mode: "demo";
  openPositions: number;
  openOrders: number;
  globalOpenPositions: number;
  globalOpenOrders: number;
  trackedOpenPositions: number;
  trackedOpenOrders: number;
  pendingEntries: number;
  lastReconcileAtMs: number;
  tradesCount: number;
  closedTrades: number;
  wins: number;
  losses: number;
  realizedPnlUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  lastExecTimeMs: number | null;
  startBalanceUsdt?: number | null;
  currentBalanceUsdt?: number | null;
  currentBalanceUpdatedAtMs?: number | null;
};

export type ManualBrokerSubmitResult = {
  accepted: boolean;
  reason?: string;
  message?: string;
  retCode?: number;
  retMsg?: string;
};

export type TickInput = {
  symbol: string;
  nowMs: number;
  markPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  signal: PaperSide | null;
  signalReason: string;
  cooldownActive: boolean;
  maxTradesPerSymbol?: number;
  configOverride?: PaperBrokerTickConfigOverride;
};

export type PendingEntry = {
  orderLinkId: string;
  side: PaperSide;
  qty: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  placedAt: number;
  expiresAt: number;
};

export type SymbolState = {
  executionState: "FLAT" | "OPENING" | "OPEN" | "CLOSING";
  entryAttempt: number;
  positionOpen: boolean;
  openTradeSlots: number;
  openTradeSlotsBySide: Record<PaperSide, number>;
  entryReservations: number;
  entryReservationsBySide: Record<PaperSide, number>;
  side: PaperSide | null;
  entryPrice: number | null;
  qty: number | null;
  tpPrice: number | null;
  slPrice: number | null;
  pendingEntries: PendingEntry[];
  cooldownUntil: number;
  lastServerUnrealizedPnl: number | null;
  realizedPnl: number;
  feesPaid: number;
  fundingAccrued: number;
};
