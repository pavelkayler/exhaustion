import type { EventLogger } from "../../logging/EventLogger.js";
import type { SymbolState } from "../types.js";
import type { BybitDemoRestClient } from "../../bybit/BybitDemoRestClient.js";

type PollDemoTransactionLogDeps = {
  token: number;
  rest: BybitDemoRestClient;
  logger: EventLogger;
  eventType: (suffix: string) => string;
  isRunningLifecycle: (token?: number) => boolean;
  parseNumber: (value: unknown) => number;
  sessionStartedAtMs: number;
  lastTransactionTimeMs: number | null;
  setLastTransactionTimeMs: (value: number | null) => void;
  transactionSeenIds: Set<string>;
  trackTransactionSeen: (id: string) => void;
  addDemoFundingUsdt: (value: number) => void;
  getState: (symbol: string) => SymbolState;
};

export async function pollDemoTransactionLog(deps: PollDemoTransactionLogDeps): Promise<void> {
  const nowMs = Date.now();
  const startFloor = deps.sessionStartedAtMs > 0 ? Math.max(0, deps.sessionStartedAtMs - 2000) : nowMs - (30 * 60 * 1000);
  const startTime = deps.lastTransactionTimeMs != null ? Math.max(startFloor, deps.lastTransactionTimeMs - 2000) : startFloor;
  const resp = await deps.rest.getTransactionLogLinear({ currency: "USDT", startTime, limit: 100 });
  if (!deps.isRunningLifecycle(deps.token)) return;
  const list = Array.isArray(resp.list) ? resp.list : [];
  let nextLastTransactionTimeMs = deps.lastTransactionTimeMs;
  for (const row of list) {
    const tsMs = Number(row.transactionTime ?? 0);
    if (Number.isFinite(tsMs) && tsMs > 0) {
      nextLastTransactionTimeMs = nextLastTransactionTimeMs == null ? tsMs : Math.max(nextLastTransactionTimeMs, tsMs);
      deps.setLastTransactionTimeMs(nextLastTransactionTimeMs);
    }
    const dedupeId = [
      String(row.id ?? ""),
      String(row.transactionTime ?? ""),
      String(row.tradeId ?? ""),
      String(row.orderId ?? ""),
      String(row.type ?? ""),
      String(row.change ?? ""),
      String(row.funding ?? ""),
      String(row.fee ?? ""),
    ].join("|");
    if (!dedupeId || deps.transactionSeenIds.has(dedupeId)) continue;
    deps.trackTransactionSeen(dedupeId);

    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const fundingAccrued = deps.parseNumber(row.funding);
    if (fundingAccrued === 0) continue;
    deps.addDemoFundingUsdt(fundingAccrued);
    if (symbol) {
      const state = deps.getState(symbol);
      state.fundingAccrued += fundingAccrued;
    }
    if (!deps.isRunningLifecycle(deps.token)) return;
    deps.logger.log({
      ts: Number.isFinite(tsMs) && tsMs > 0 ? tsMs : nowMs,
      type: deps.eventType("FUNDING_SETTLEMENT"),
      ...(symbol ? { symbol } : {}),
      payload: {
        fundingAccrued,
        transactionType: String(row.type ?? ""),
        transSubType: String(row.transSubType ?? ""),
        change: deps.parseNumber(row.change),
        fee: deps.parseNumber(row.fee),
        cashFlow: deps.parseNumber(row.cashFlow),
        currency: String(row.currency ?? "USDT"),
        orderId: String(row.orderId ?? ""),
        tradeId: String(row.tradeId ?? ""),
      },
    });
  }
}
