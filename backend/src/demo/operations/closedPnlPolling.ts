import type { EventLogger } from "../../logging/EventLogger.js";
import type { PaperSide } from "../../paper/PaperBroker.js";
import type { SymbolState } from "../types.js";
import type { BybitDemoRestClient } from "../../bybit/BybitDemoRestClient.js";

type PollDemoClosedPnlDeps = {
  token: number;
  rest: BybitDemoRestClient;
  logger: EventLogger;
  eventType: (suffix: string) => string;
  isRunningLifecycle: (token?: number) => boolean;
  parseNumber: (value: unknown) => number;
  sessionStartedAtMs: number;
  lastClosedPnlTimeMs: number | null;
  setLastClosedPnlTimeMs: (value: number | null) => void;
  closedPnlSeenIds: Set<string>;
  trackClosedPnlSeen: (id: string) => void;
  inferPositionSideFromCloseOrder: (orderSideRaw: unknown) => PaperSide;
  applyClosedTradeStats: (args: {
    symbol: string;
    side: PaperSide;
    realizedPnl: number;
    feesPaid: number;
    fundingAccrued?: number;
    closedAtMs: number;
    source: "closed_pnl" | "execution";
    payload?: Record<string, unknown>;
  }) => void;
  getState: (symbol: string) => SymbolState;
  refreshExecutionState: (state: SymbolState) => void;
};

export async function pollDemoClosedPnl(deps: PollDemoClosedPnlDeps): Promise<void> {
  const nowMs = Date.now();
  const startFloor = deps.sessionStartedAtMs > 0 ? Math.max(0, deps.sessionStartedAtMs - 2000) : nowMs - (5 * 60 * 1000);
  const startTime = deps.lastClosedPnlTimeMs != null ? Math.max(startFloor, deps.lastClosedPnlTimeMs - 2000) : startFloor;
  const resp = await deps.rest.getClosedPnlLinear({ startTime, limit: 100 });
  if (!deps.isRunningLifecycle(deps.token)) return;
  const list = Array.isArray(resp.list) ? resp.list : [];
  let nextLastClosedPnlTimeMs = deps.lastClosedPnlTimeMs;
  for (const row of list) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const updatedTimeMs = Number(row.updatedTime ?? row.createdTime ?? 0);
    if (Number.isFinite(updatedTimeMs) && updatedTimeMs > 0) {
      nextLastClosedPnlTimeMs = nextLastClosedPnlTimeMs == null ? updatedTimeMs : Math.max(nextLastClosedPnlTimeMs, updatedTimeMs);
      deps.setLastClosedPnlTimeMs(nextLastClosedPnlTimeMs);
    }
    const closedAtMs = Number.isFinite(updatedTimeMs) && updatedTimeMs > 0 ? updatedTimeMs : nowMs;
    const dedupeId = [
      symbol,
      String(row.orderId ?? ""),
      String(row.updatedTime ?? ""),
      String(row.closedSize ?? ""),
      String(row.closedPnl ?? ""),
    ].join("|");
    if (!dedupeId || deps.closedPnlSeenIds.has(dedupeId)) continue;
    deps.trackClosedPnlSeen(dedupeId);

    const realizedPnl = deps.parseNumber(row.closedPnl);
    const openFee = deps.parseNumber(row.openFee);
    const closeFee = deps.parseNumber(row.closeFee);
    const feesPaid = openFee + closeFee;
    const side = deps.inferPositionSideFromCloseOrder(row.side);
    if (!deps.isRunningLifecycle(deps.token)) return;
    deps.applyClosedTradeStats({
      symbol,
      side,
      realizedPnl,
      feesPaid,
      closedAtMs,
      source: "closed_pnl",
      payload: {
        orderId: String(row.orderId ?? ""),
        avgEntryPrice: deps.parseNumber(row.avgEntryPrice),
        avgExitPrice: deps.parseNumber(row.avgExitPrice),
        closedSize: deps.parseNumber(row.closedSize),
        fillCount: deps.parseNumber(row.fillCount),
        feesPaid,
      },
    });
    const state = deps.getState(symbol);
    state.openTradeSlotsBySide[side] = Math.max(0, (Number(state.openTradeSlotsBySide[side]) || 0) - 1);
    state.openTradeSlots = Math.max(0, state.openTradeSlotsBySide.LONG + state.openTradeSlotsBySide.SHORT);
    if (state.positionOpen && state.side && state.openTradeSlots === 0) {
      state.openTradeSlotsBySide[state.side] = 1;
      state.openTradeSlots = 1;
    }
    deps.refreshExecutionState(state);
  }
}
