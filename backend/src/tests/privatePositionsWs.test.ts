import { describe, expect, it } from "vitest";
import {
  computeImmediateShortEntryTakeProfit,
  computeSignalEntryBudget,
  hasOpenExecutionPositionForSymbol,
  estimateFilledGridOrders,
  normalizePositionRow,
  resolveExecutionSignalEligibilitySkipReason,
  resolveTradeableSignalSkipReason,
  selectEntryQtyWithinTolerance,
  shouldPlaceFirstShortEntryAsMarket,
  shouldFallbackToMarketCloseForProtection,
} from "../api/privatePositionsWs.js";

describe("private execution first entry order type", () => {
  it("uses market only for the first entry when offset is zero or below", () => {
    expect(shouldPlaceFirstShortEntryAsMarket(0, 0)).toBe(true);
    expect(shouldPlaceFirstShortEntryAsMarket(0, -1)).toBe(true);
  });

  it("keeps the first entry limit when offset is above zero", () => {
    expect(shouldPlaceFirstShortEntryAsMarket(0, 0.01)).toBe(false);
  });

  it("never switches grid follow-up orders to market", () => {
    expect(shouldPlaceFirstShortEntryAsMarket(1, 0)).toBe(false);
    expect(shouldPlaceFirstShortEntryAsMarket(2, 0)).toBe(false);
  });
});

describe("private execution immediate market tp", () => {
  it("computes a rounded take profit for the first market short entry", () => {
    expect(computeImmediateShortEntryTakeProfit({
      entryPrice: 0.18946,
      tickSize: 0.00001,
      tpPct: 5,
    })).toBe("0.17999");
  });

  it("returns null when a valid rounded tp cannot be produced", () => {
    expect(computeImmediateShortEntryTakeProfit({
      entryPrice: 0,
      tickSize: 0.00001,
      tpPct: 5,
    })).toBeNull();
  });
});

describe("private execution qty selection with small overspend tolerance", () => {
  it("rounds up when the next qty step stays within tolerance", () => {
    const qty = selectEntryQtyWithinTolerance({
      targetNotional: 100,
      price: 25.43189,
      qtyStep: 1,
    });

    expect(qty).toBe(4);
  });

  it("keeps rounded down qty when the next step would overspend too much", () => {
    const qty = selectEntryQtyWithinTolerance({
      targetNotional: 100,
      price: 27.97508,
      qtyStep: 1,
    });

    expect(qty).toBe(3);
  });
});

describe("private execution grid order estimation", () => {
  it("clamps filled grid orders to configured grid size", () => {
    const filled = estimateFilledGridOrders({
      entryPrice: 23.56608,
      positionSize: 13,
      marginPerOrder: 5,
      leverage: 10,
      maxGridOrders: 3,
    });

    expect(filled).toBe(3);
  });
});

describe("private execution leverage adaptation", () => {
  it("keeps target notional but lowers effective leverage to symbol max", () => {
    const budget = computeSignalEntryBudget({
      marginPerOrder: 5,
      strategyLeverage: 10,
      symbolMaxLeverage: 5,
    });

    expect(budget.targetNotionalPerOrder).toBe(50);
    expect(budget.effectiveLeverage).toBe(5);
    expect(budget.effectiveMarginPerOrder).toBe(10);
  });

  it("uses strategy leverage when symbol does not impose a lower max", () => {
    const budget = computeSignalEntryBudget({
      marginPerOrder: 5,
      strategyLeverage: 10,
      symbolMaxLeverage: 25,
    });

    expect(budget.targetNotionalPerOrder).toBe(50);
    expect(budget.effectiveLeverage).toBe(10);
    expect(budget.effectiveMarginPerOrder).toBe(5);
  });
});

describe("private execution fallback to market close", () => {
  it("closes short by market when tp is already crossed", () => {
    expect(shouldFallbackToMarketCloseForProtection({
      side: "SELL",
      currentPrice: 22.3,
      targetPrice: 22.4,
      protectionType: "tp",
    })).toBe(true);
  });

  it("closes short by market when sl is already crossed", () => {
    expect(shouldFallbackToMarketCloseForProtection({
      side: "SELL",
      currentPrice: 29.5,
      targetPrice: 29.4,
      protectionType: "sl",
    })).toBe(true);
  });

  it("does not trigger fallback when the threshold is not crossed yet", () => {
    expect(shouldFallbackToMarketCloseForProtection({
      side: "SELL",
      currentPrice: 23.8,
      targetPrice: 22.4,
      protectionType: "tp",
    })).toBe(false);
    expect(shouldFallbackToMarketCloseForProtection({
      side: "SELL",
      currentPrice: 28.9,
      targetPrice: 29.4,
      protectionType: "sl",
    })).toBe(false);
  });
});

describe("private execution position normalization", () => {
  it("refreshes entry price from entryPrice when Bybit omits avgPrice", () => {
    const previous = normalizePositionRow({
      symbol: "RAVEUSDT",
      side: "Sell",
      size: "80",
      entryPrice: "3.03445",
      positionIdx: 2,
      markPrice: "1.9",
    }, null, 1_000);

    const next = normalizePositionRow({
      symbol: "RAVEUSDT",
      side: "Sell",
      size: "80",
      entryPrice: "1.25445",
      positionIdx: 2,
      markPrice: "1.79206",
    }, previous, 2_000);

    expect(previous?.entryPrice).toBe(3.03445);
    expect(next?.entryPrice).toBe(1.25445);
  });

  it("preserves bot-managed reason when a later position row loses order metadata", () => {
    const previous = normalizePositionRow({
      symbol: "RAVEUSDT",
      side: "Sell",
      size: "80",
      entryPrice: "1.25",
      orderLinkId: "executor_candidate_RAVEUSDT_1_1",
      positionIdx: 2,
    }, null, 1_000);

    const next = normalizePositionRow({
      symbol: "RAVEUSDT",
      side: "Sell",
      size: "80",
      entryPrice: "1.25",
      positionIdx: 2,
    }, previous, 2_000);

    expect(previous?.reason).toBe("candidate");
    expect(next?.reason).toBe("candidate");
  });
});

describe("private execution signal entry guards", () => {
  it("detects an already-open position for the symbol", () => {
    expect(hasOpenExecutionPositionForSymbol([
      { symbol: "ENJUSDT", size: 10 },
      { symbol: "RAVEUSDT", size: 0 },
    ] as any, "ENJUSDT")).toBe(true);
  });

  it("blocks a post-refresh signal submission when the symbol is already open", () => {
    expect(resolveTradeableSignalSkipReason({
      symbol: "ENJUSDT",
      positions: [{ symbol: "ENJUSDT", size: 6156.7 }] as any,
      cooldownActive: false,
      excluded: false,
      afterRefresh: true,
    })).toBe("position_already_open_after_refresh");
  });

  it("blocks hard-excluded symbols before any order placement", () => {
    expect(resolveTradeableSignalSkipReason({
      symbol: "USDCUSDT",
      positions: [],
      cooldownActive: false,
      excluded: true,
    })).toBe("symbol_hard_excluded");
  });
});

describe("private execution signal eligibility", () => {
  it("blocks watchlist candidate-class signals that are not tradeable", () => {
    expect(resolveExecutionSignalEligibilitySkipReason({
      reason: "candidate",
      state: "WATCHLIST",
      advisoryVerdict: "WATCHLIST",
    })).toBe("candidate_not_tradeable");
  });

  it("allows raw candidate signals even before advisory tradeable verdict", () => {
    expect(resolveExecutionSignalEligibilitySkipReason({
      reason: "candidate",
      state: "CANDIDATE",
      advisoryVerdict: "NO_TRADE",
    })).toBeNull();
  });

  it("allows confirmed candidate-class signals even before advisory tradeable verdict", () => {
    expect(resolveExecutionSignalEligibilitySkipReason({
      reason: "candidate",
      state: "CONFIRMED",
      advisoryVerdict: "OBSERVE_ONLY",
    })).toBeNull();
  });

  it("allows tradeable watchlist candidate-class signals", () => {
    expect(resolveExecutionSignalEligibilitySkipReason({
      reason: "candidate",
      state: "WATCHLIST",
      advisoryVerdict: "TRADEABLE",
    })).toBeNull();
  });
});
