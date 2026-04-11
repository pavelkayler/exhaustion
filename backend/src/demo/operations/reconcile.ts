import type { BybitDemoRestClient } from "../../bybit/BybitDemoRestClient.js";
import type { EventLogger } from "../../logging/EventLogger.js";
import type { PaperSide } from "../../paper/PaperBroker.js";
import { applyGlobalRearmCooldown } from "../../runtime/rearmPolicy.js";
import type { PendingEntry, SymbolState } from "../types.js";

type ReconcileDemoBrokerDeps = {
  token: number;
  rest: BybitDemoRestClient;
  logger: EventLogger;
  eventType: (suffix: string) => string;
  isRunningLifecycle: (token?: number) => boolean;
  map: Map<string, SymbolState>;
  setLastReconcileAtMs: (value: number) => void;
  setGlobalOpenOrdersCount: (value: number) => void;
  setGlobalOpenPositionsCount: (value: number) => void;
  setTrackedOpenOrdersCount: (value: number) => void;
  setTrackedOpenPositionsCount: (value: number) => void;
  setOpenOrdersCache: (value: Array<{ symbol: string; orderLinkId: string }>) => void;
  setOpenOrderSymbolsCache: (value: Set<string>) => void;
  inferServerPositionSide: (row: Record<string, any> | null | undefined) => PaperSide | null;
  applyAggregatedServerPositions: (symbol: string, positions: Array<Record<string, any>>) => SymbolState;
  refreshExecutionState: (state: SymbolState) => void;
};

function hasTradingStopValue(value: unknown): boolean {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0;
}

function toPositionIdx(side: PaperSide): 1 | 2 {
  return side === "LONG" ? 1 : 2;
}

export async function reconcileDemoBroker(deps: ReconcileDemoBrokerDeps): Promise<void> {
  const nowMs = Date.now();
  const [positionsResp, openOrdersResp] = await Promise.all([
    deps.rest.getPositionsLinear({ settleCoin: "USDT" }),
    deps.rest.getOpenOrdersLinear({ settleCoin: "USDT" }),
  ]);
  if (!deps.isRunningLifecycle(deps.token)) return;

  const universeSymbols = new Set(Array.from(deps.map.keys()));
  const openOrdersAll = Array.isArray(openOrdersResp.list) ? openOrdersResp.list : [];
  const openOrders = openOrdersAll.filter((order) => universeSymbols.has(String(order.symbol ?? "")));
  const positionsAll = Array.isArray(positionsResp.list) ? positionsResp.list : [];
  const activePositionsAll = positionsAll.filter((position) => Number(position.size ?? "0") !== 0);
  const positions = activePositionsAll.filter((position) => universeSymbols.has(String(position.symbol ?? "")));

  deps.setLastReconcileAtMs(nowMs);
  deps.setGlobalOpenOrdersCount(openOrdersAll.length);
  deps.setGlobalOpenPositionsCount(activePositionsAll.length);
  deps.setTrackedOpenOrdersCount(openOrders.length);
  deps.setTrackedOpenPositionsCount(positions.length);
  deps.setOpenOrdersCache(
    openOrders
      .map((order) => ({ symbol: String(order.symbol ?? ""), orderLinkId: String(order.orderLinkId ?? "") }))
      .filter((order) => order.symbol.length > 0 && order.orderLinkId.length > 0),
  );
  deps.setOpenOrderSymbolsCache(new Set(openOrders.map((order) => String((order as any).symbol ?? "")).filter((symbol) => symbol.length > 0)));
  deps.logger.log({
    ts: nowMs,
    type: deps.eventType("RECONCILE_OK"),
    payload: {
      trackedOpenOrders: openOrders.length,
      trackedOpenPositions: positions.length,
      globalOpenOrders: openOrdersAll.length,
      globalOpenPositions: activePositionsAll.length,
    },
  });

  const positionBySymbol = new Map<string, Array<Record<string, any>>>();
  for (const row of positions) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const current = positionBySymbol.get(symbol) ?? [];
    current.push(row as Record<string, any>);
    positionBySymbol.set(symbol, current);
  }

  for (const [symbol, state] of deps.map.entries()) {
    const serverPositions = positionBySymbol.get(symbol) ?? [];
    const remainingPending: PendingEntry[] = [];
    for (const pending of state.pendingEntries) {
      const hasOpenOrder = openOrders.some((order) => String(order.orderLinkId ?? "") === pending.orderLinkId && String(order.symbol ?? "") === symbol);
      if (hasOpenOrder) {
        remainingPending.push(pending);
        continue;
      }
      const matchingServerPos = serverPositions.find((row) => deps.inferServerPositionSide(row) === pending.side);
      if (matchingServerPos) {
        state.openTradeSlotsBySide[pending.side] = Math.max(0, Number(state.openTradeSlotsBySide[pending.side]) || 0) + 1;
        state.openTradeSlots = state.openTradeSlotsBySide.LONG + state.openTradeSlotsBySide.SHORT;
        deps.applyAggregatedServerPositions(symbol, serverPositions);

        if (!deps.isRunningLifecycle(deps.token)) return;
        deps.logger.log({ ts: nowMs, type: deps.eventType("POSITION_OPEN"), symbol, payload: { side: pending.side, entryPrice: pending.entryPrice, qty: pending.qty, orderLinkId: pending.orderLinkId } });

        const missingTp = !hasTradingStopValue(matchingServerPos.takeProfit);
        const missingSl = !hasTradingStopValue(matchingServerPos.stopLoss);
        if ((missingTp || missingSl) && (pending.tpPrice != null || pending.slPrice != null)) {
          try {
            await deps.rest.setTradingStopLinear({
              symbol,
              positionIdx: toPositionIdx(pending.side),
              ...(pending.tpPrice != null ? { takeProfit: pending.tpPrice.toFixed(6) } : {}),
              ...(pending.slPrice != null ? { stopLoss: pending.slPrice.toFixed(6) } : {}),
              tpTriggerBy: "MarkPrice",
              slTriggerBy: "MarkPrice",
              tpslMode: "Full",
              tpOrderType: "Market",
              slOrderType: "Market",
            });
            deps.logger.log({
              ts: nowMs,
              type: deps.eventType("TRADING_STOP_SYNC"),
              symbol,
              payload: {
                side: pending.side,
                orderLinkId: pending.orderLinkId,
                positionIdx: toPositionIdx(pending.side),
                tp: pending.tpPrice,
                sl: pending.slPrice,
                missingTp,
                missingSl,
              },
            });
          } catch (err: any) {
            deps.logger.log({
              ts: nowMs,
              type: deps.eventType("TRADING_STOP_SYNC_FAIL"),
              symbol,
              payload: {
                side: pending.side,
                orderLinkId: pending.orderLinkId,
                positionIdx: toPositionIdx(pending.side),
                tp: pending.tpPrice,
                sl: pending.slPrice,
                missingTp,
                missingSl,
                retCode: err?.retCode,
                retMsg: err?.retMsg ?? err?.message,
              },
            });
          }
        }
        continue;
      }
    }
    state.pendingEntries = remainingPending;

    if (state.positionOpen && serverPositions.length === 0) {
      if (!deps.isRunningLifecycle(deps.token)) return;
      deps.logger.log({ ts: nowMs, type: deps.eventType("POSITION_CLOSE"), symbol, payload: { reason: "UNKNOWN" } });
      deps.applyAggregatedServerPositions(symbol, []);
      state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, nowMs);
    } else if (serverPositions.length > 0) {
      deps.applyAggregatedServerPositions(symbol, serverPositions);
    } else {
      deps.refreshExecutionState(state);
    }
  }

  for (const [symbol, serverPositions] of positionBySymbol.entries()) {
    if (!symbol) continue;
    deps.applyAggregatedServerPositions(symbol, serverPositions);
  }
}
