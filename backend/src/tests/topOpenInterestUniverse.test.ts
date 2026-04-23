import { describe, expect, it } from "vitest";
import {
  rankTopOpenInterestSymbols,
  resolveTopOpenInterestUniverseSettings,
  shouldApplyTopOpenInterestUniverseRefresh,
} from "../runtime/topOpenInterestUniverse.js";

describe("top open interest universe mode settings", () => {
  it("keeps legacy mode on top100 hourly refresh by default", () => {
    const settings = resolveTopOpenInterestUniverseSettings({
      botConfig: {
        observe: {
          useHotRegimeTracking: false,
        },
      } as any,
    } as any);

    expect(settings.mode).toBe("legacy");
    expect(settings.limit).toBe(100);
    expect(settings.refreshMs).toBe(60 * 60 * 1000);
    expect(settings.universeId).toBe("bybit-linear-usdt-open-interest-top100");
  });

  it("uses hot regime top200 with 15 minute refresh when enabled", () => {
    const settings = resolveTopOpenInterestUniverseSettings({
      botConfig: {
        observe: {
          useHotRegimeTracking: true,
        },
      } as any,
    } as any);

    expect(settings.mode).toBe("hot_regime");
    expect(settings.limit).toBe(200);
    expect(settings.refreshMs).toBe(15 * 60 * 1000);
    expect(settings.universeId).toBe("bybit-linear-usdt-open-interest-top200");
  });

  it("ranks by openInterestValue first, then fallback value, then symbol", () => {
    const ranked = rankTopOpenInterestSymbols([
      { symbol: "ZZZUSDT", openInterestValue: "100" },
      { symbol: "AAAUSDT", openInterestValue: "100" },
      { symbol: "MIDUSDT", openInterest: "10", lastPrice: "9" },
      { symbol: "USDCUSDT", openInterestValue: "1000" },
      { symbol: "XAUTUSDT", openInterestValue: "999" },
      { symbol: "BADUSDT", openInterestValue: "0", openInterest: "0", lastPrice: "10" },
      { symbol: "BTCUSD", openInterestValue: "1000" },
    ], 3);

    expect(ranked).toEqual(["AAAUSDT", "ZZZUSDT", "MIDUSDT"]);
  });

  it("ignores stale refresh results after the mode changes", () => {
    const legacySettings = resolveTopOpenInterestUniverseSettings({
      botConfig: {
        observe: {
          useHotRegimeTracking: false,
        },
      } as any,
    } as any);
    const hotSettings = resolveTopOpenInterestUniverseSettings({
      botConfig: {
        observe: {
          useHotRegimeTracking: true,
        },
      } as any,
    } as any);

    expect(shouldApplyTopOpenInterestUniverseRefresh({
      requestId: 1,
      latestRequestId: 2,
      startedSettings: legacySettings,
      currentSettings: hotSettings,
    })).toBe(false);
    expect(shouldApplyTopOpenInterestUniverseRefresh({
      requestId: 2,
      latestRequestId: 2,
      startedSettings: hotSettings,
      currentSettings: hotSettings,
    })).toBe(true);
  });
});
