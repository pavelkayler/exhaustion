import { BybitPrivateWsClient } from "../bybit/BybitPrivateWsClient.js";
import { BybitRealRestClient } from "../bybit/BybitRealRestClient.js";
import { DemoBroker, type DemoStats, type ManualBrokerSubmitResult } from "../demo/DemoBroker.js";
import { placeManualDemoOrder } from "../demo/operations/manualOrder.js";
import type { EventLogger } from "../logging/EventLogger.js";
import type { PaperBrokerConfig, PaperBrokerTickConfigOverride, PaperSide } from "../paper/PaperBroker.js";

export type RealStats = Omit<DemoStats, "mode"> & { mode: "real" };

type SymbolStateLike = {
  executionState: "FLAT" | "OPENING" | "OPEN" | "CLOSING";
  entryAttempt: number;
  positionOpen: boolean;
  openTradeSlots: number;
  entryReservations: number;
  side: PaperSide | null;
  entryPrice: number | null;
  qty: number | null;
  tpPrice: number | null;
  slPrice: number | null;
  pendingEntries: Array<{
    orderLinkId: string;
    side: PaperSide;
    qty: number;
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
    placedAt: number;
    expiresAt: number;
  }>;
  cooldownUntil: number;
  lastServerUnrealizedPnl: number | null;
  realizedPnl: number;
  feesPaid: number;
  fundingAccrued: number;
  placementInFlight: boolean;
};

function parseNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseWalletUsdtBalance(row: Record<string, any>): number | null {
  const accounts = Array.isArray(row?.coin)
    ? [{ coin: row.coin }]
    : Array.isArray(row?.list)
      ? row.list
      : [row];
  for (const account of accounts) {
    const coins = Array.isArray(account?.coin) ? account.coin : [];
    const usdt = coins.find((coin: any) => String(coin?.coin ?? "").toUpperCase() === "USDT");
    if (!usdt) continue;
    for (const value of [usdt.walletBalance, usdt.equity, usdt.availableToWithdraw, usdt.availableBalance]) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export class RealBroker extends DemoBroker {
  private privateWs: BybitPrivateWsClient | null = null;
  private wsPositionBySymbolSide = new Map<string, Map<PaperSide, Record<string, any>>>();

  constructor(
    cfg: PaperBrokerConfig,
    logger: EventLogger,
    runId: string,
    getMarkPrice?: (symbol: string) => number | null,
  ) {
    super(cfg, logger, runId, getMarkPrice);
    (this as any).rest = new BybitRealRestClient();
  }

  protected override getEventPrefix(): "REAL" {
    return "REAL";
  }

  protected override getMissingApiKeysReason(): string {
    return "missing_real_api_keys";
  }

  override start() {
    super.start();
    this.ensurePrivateWs();
    this.privateWs?.connect();
    this.privateWs?.subscribe(["order", "execution", "position", "wallet"]);
  }

  override stop() {
    this.privateWs?.close();
    this.privateWs = null;
    this.wsPositionBySymbolSide.clear();
    super.stop();
  }

  getRealStats(): RealStats {
    const base = super.getStats();
    return {
      ...base,
      mode: "real",
    };
  }

  async placeManualOrder(args: {
    symbol: string;
    side: PaperSide;
    nowMs: number;
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
    maxTradesPerSymbol?: number;
    configOverride?: PaperBrokerTickConfigOverride;
    reason?: string;
  }): Promise<ManualBrokerSubmitResult> {
    return placeManualDemoOrder({
      brokerLabel: "Real",
      cfg: (this as any).cfg as PaperBrokerConfig,
      logger: this.getLogger(),
      rest: this.getRest(),
      runId: (this as any).runId as string,
      missingKeysLogged: Boolean((this as any).missingKeysLogged),
      setMissingKeysLogged: (value) => {
        (this as any).missingKeysLogged = value;
      },
      getMissingApiKeysReason: () => this.getMissingApiKeysReason(),
      eventType: (suffix) => this.eventType(suffix),
      getState: (symbol) => this.getSymbolState(symbol) as any,
      getActiveTradesCount: (symbol, side) => this.getActiveTradesCount(symbol, side),
      reserveEntrySlot: (state, side) => (this as any).reserveEntrySlot(state, side),
      releaseEntrySlot: (state, side) => (this as any).releaseEntrySlot(state, side),
      getMeta: (symbol) => (this as any).getMeta(symbol),
      ensureLeverageConfigured: (nextArgs, state) => (this as any).ensureLeverageConfigured(nextArgs, state),
      onTickRestError: (nextArgs, stage, err, state) => (this as any).onTickRestError(nextArgs, stage, err, state),
      clearPendingByOrderLinkId: (state, orderLinkId) => (this as any).clearPendingByOrderLinkId(state, orderLinkId),
      refreshExecutionState: (state) => (this as any).refreshExecutionState(state),
    }, args);
  }

  private ensurePrivateWs() {
    if (this.privateWs) return;
    const rest = this.getRest();
    if (!rest.hasCredentials()) return;
    this.privateWs = new BybitPrivateWsClient({
      url: process.env.BYBIT_PRIVATE_WS_URL ?? "wss://stream.bybit.com/v5/private",
      apiKey: rest.apiKey,
      apiSecret: rest.apiSecret,
      handlers: {
        onOrder: (row) => this.handleOrderWs(row),
        onExecution: (row) => this.handleExecutionWs(row),
        onPosition: (row) => this.handlePositionWs(row),
        onWallet: (row) => this.handleWalletWs(row),
      },
    });
  }

  private getRest(): BybitRealRestClient {
    return (this as any).rest as BybitRealRestClient;
  }

  private getLogger(): EventLogger {
    return (this as any).logger as EventLogger;
  }

  private getSymbolState(symbol: string): SymbolStateLike {
    return ((this as any).getState(symbol)) as SymbolStateLike;
  }

  private getStateMap(): Map<string, SymbolStateLike> {
    return ((this as any).map) as Map<string, SymbolStateLike>;
  }

  private handleOrderWs(row: Record<string, any>) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) return;
    const openOrdersCache = ((this as any).openOrdersCache ?? []) as Array<{ symbol: string; orderLinkId: string }>;
    const openOrderSymbolsCache = ((this as any).openOrderSymbolsCache ?? new Set<string>()) as Set<string>;
    const orderKey = String(row.orderLinkId ?? row.orderId ?? "").trim();
    const status = String(row.orderStatus ?? "").trim();
    const isOpenStatus = ["New", "PartiallyFilled", "Untriggered"].includes(status);
    const isFinalStatus = ["Filled", "Cancelled", "Rejected", "Deactivated", "PartiallyFilledCanceled"].includes(status);

    if (isOpenStatus && orderKey) {
      if (!openOrdersCache.some((item) => item.symbol === symbol && item.orderLinkId === orderKey)) {
        openOrdersCache.push({ symbol, orderLinkId: orderKey });
      }
      openOrderSymbolsCache.add(symbol);
    }

    if (isFinalStatus && orderKey) {
      const next = openOrdersCache.filter((item) => !(item.symbol === symbol && item.orderLinkId === orderKey));
      (this as any).openOrdersCache = next;
      if (!next.some((item) => item.symbol === symbol)) {
        openOrderSymbolsCache.delete(symbol);
      }
    }
  }

  private handleExecutionWs(row: Record<string, any>) {
    const execId = String(row.execId ?? "").trim();
    if (!execId) return;
    const execSeenIds = ((this as any).execSeenIds ?? new Set<string>()) as Set<string>;
    if (execSeenIds.has(execId)) return;
    (this as any).trackExecSeen(execId);
    const ts = Number(row.execTime ?? 0);
    if (Number.isFinite(ts) && ts > 0) {
      (this as any).lastExecTimeMs = (this as any).lastExecTimeMs == null ? ts : Math.max((this as any).lastExecTimeMs, ts);
    }
    this.getLogger().log({
      ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      type: "REAL_FILL",
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      payload: {
        execId,
        orderId: String(row.orderId ?? ""),
        side: String(row.side ?? "").toUpperCase(),
        execPrice: parseNumber(row.execPrice ?? row.orderPrice),
        execQty: parseNumber(row.execQty),
        execFee: parseNumber(row.execFee),
        execType: String(row.execType ?? ""),
      },
    });
  }

  private handlePositionWs(row: Record<string, any>) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) return;
    const size = parseNumber(row.size);
    const side = (this as any).inferServerPositionSide(row) as PaperSide | null;
    if (!side) return;
    const symbolPositions = this.wsPositionBySymbolSide.get(symbol) ?? new Map<PaperSide, Record<string, any>>();
    const hadSideOpen = symbolPositions.has(side);
    if (size > 0) {
      symbolPositions.set(side, row);
      if (!hadSideOpen) {
        this.getLogger().log({
          ts: Date.now(),
          type: "REAL_POSITION_OPEN_WS",
          symbol,
          payload: { side, entryPrice: parseNumber(row.avgPrice), qty: size },
        });
      }
    } else {
      if (hadSideOpen) {
        this.getLogger().log({
          ts: Date.now(),
          type: "REAL_POSITION_CLOSE_WS",
          symbol,
          payload: { reason: "WS_ZERO_SIZE", side },
        });
      }
      symbolPositions.delete(side);
    }
    if (symbolPositions.size > 0) {
      this.wsPositionBySymbolSide.set(symbol, symbolPositions);
    } else {
      this.wsPositionBySymbolSide.delete(symbol);
    }
    (this as any).applyAggregatedServerPositions(symbol, Array.from(symbolPositions.values()));
    (this as any).trackedOpenPositionsCount = Array.from(this.wsPositionBySymbolSide.values()).reduce((total, entry) => total + entry.size, 0);
  }

  private handleWalletWs(row: Record<string, any>) {
    const balance = parseWalletUsdtBalance(row);
    if (balance == null) return;
    (this as any).currentBalanceUsdt = balance;
    (this as any).currentBalanceUpdatedAtMs = Date.now();
  }
}
