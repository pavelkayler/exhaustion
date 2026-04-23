import { describe, expect, it } from "vitest";
import { SHORT_EXHAUSTION_BOT_ID, getBotDefinition } from "../bots/registry.js";
import {
  buildBybitTopics,
  HOT_MODE_ORDERBOOK_STICKY_MS,
  isHotModeOrderbookPromotedState,
  resolveHotModeOrderbookSymbols,
  type SubscriptionTargets,
} from "../api/wsHub.js";

describe("wsHub hot regime subscriptions", () => {
  it("keeps public trades and liquidations on the full hot-mode top200 while staging orderbook", () => {
    const symbols = Array.from({ length: 200 }, (_, index) => `ALT${index + 1}USDT`);
    const orderbookSymbols = [symbols[0]!, symbols[9]!, symbols[49]!];
    const cfg = {
      selectedBotId: SHORT_EXHAUSTION_BOT_ID,
      botConfig: getBotDefinition().normalizeBotConfig({
        ...getBotDefinition().defaults,
        observe: {
          ...getBotDefinition().defaults.observe,
          useHotRegimeTracking: true,
        },
      }),
      universe: {
        selectedId: "bybit-linear-usdt-open-interest-top200",
        symbols,
        klineTfMin: 1,
      },
    } as any;

    const targets: SubscriptionTargets = {
      tradingSymbols: symbols,
      recorderSymbols: [],
      tickerSymbols: symbols,
      publicTradeSymbols: symbols,
      liquidationSymbols: symbols,
      orderbookSymbols,
      tradingKlineTf: 1,
    };

    const topics = buildBybitTopics(cfg, targets);
    expect(topics.filter((topic) => topic.startsWith("publicTrade.")).length).toBe(200);
    expect(topics.filter((topic) => topic.startsWith("allLiquidation.")).length).toBe(200);
    expect(topics.filter((topic) => topic.startsWith("orderbook.50.")).length).toBe(orderbookSymbols.length);
    expect(topics).toContain(`orderbook.50.${orderbookSymbols[0]}`);
    expect(topics).not.toContain(`orderbook.50.${symbols[199]}`);
  });

  it("filters hard-excluded symbols from hot-mode subscription topics", () => {
    const symbols = ["ALT1USDT", "USDCUSDT", "XAUTUSDT", "PAXGUSDT", "ALT2USDT"];
    const cfg = {
      selectedBotId: SHORT_EXHAUSTION_BOT_ID,
      botConfig: getBotDefinition().normalizeBotConfig({
        ...getBotDefinition().defaults,
        observe: {
          ...getBotDefinition().defaults.observe,
          useHotRegimeTracking: true,
        },
      }),
      universe: {
        selectedId: "bybit-linear-usdt-open-interest-top200",
        symbols,
        klineTfMin: 1,
      },
    } as any;

    const targets: SubscriptionTargets = {
      tradingSymbols: symbols,
      recorderSymbols: [],
      tickerSymbols: symbols,
      publicTradeSymbols: symbols,
      liquidationSymbols: symbols,
      orderbookSymbols: symbols,
      tradingKlineTf: 1,
    };

    const topics = buildBybitTopics(cfg, targets);
    expect(topics).toContain("tickers.ALT1USDT");
    expect(topics).toContain("tickers.ALT2USDT");
    expect(topics.some((topic) => topic.includes("USDCUSDT"))).toBe(false);
    expect(topics.some((topic) => topic.includes("XAUTUSDT"))).toBe(false);
    expect(topics.some((topic) => topic.includes("PAXGUSDT"))).toBe(false);
  });

  it("keeps hot-mode orderbook symbols sticky until expiry", () => {
    const now = 10_000;
    const symbols = ["ALT1USDT", "ALT2USDT", "ALT3USDT"];
    const promotionExpiries = new Map<string, number>([
      ["ALT1USDT", now + HOT_MODE_ORDERBOOK_STICKY_MS],
      ["ALT2USDT", now - 1],
    ]);

    expect(resolveHotModeOrderbookSymbols(symbols, promotionExpiries, now)).toEqual(["ALT1USDT"]);
    expect(isHotModeOrderbookPromotedState("WATCHLIST")).toBe(false);
    expect(isHotModeOrderbookPromotedState("CANDIDATE")).toBe(true);
    expect(isHotModeOrderbookPromotedState("FINAL")).toBe(true);
  });
});
