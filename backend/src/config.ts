export const CONFIG = {
    bybit: {
        wsUrl: "wss://stream.bybit.com/v5/public/linear"
    },

    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const,

    klineTfMin: 1,

    fundingCooldown: {
        beforeMin: 5,
        afterMin: 5
    },

    signals: {
        priceThresholdPct: 0.03,
        oivThresholdPct: 0.05,
        requireFundingSign: true,
        fundingMinAbsPct: 0.00005,
        modelMinScore: 1.05,
        modelScoreDelta: 0.25,
        modelPriceWeight: 0.42,
        modelOiWeight: 0.43,
        modelFundingWeight: 0.15,
        dailyTriggerMin: 1,
        dailyTriggerMax: 999
    },

    paper: {
        enabled: true,
        directionMode: "both" as "both" | "long" | "short",

        marginUSDT: 10,
        leverage: 5,

        entryOffsetPct: 0.02,
        entryTimeoutSec: 300,

        tpRoiPct: 2.0,
        slRoiPct: 2.5,

        makerFeeRate: 0.0002,
        applyFunding: true,

        rearmDelayMs: 60_000,
        maxDailyLossUSDT: 0
    },

    riskLimits: {
        maxTradesPerDay: 2,
        maxLossPerDayUsdt: null as number | null,
        maxLossPerSessionUsdt: null as number | null,
        maxConsecutiveErrors: 10,
        burstWindowSec: 20,
        maxBurstEntriesPerSide: 3,
    }
};
